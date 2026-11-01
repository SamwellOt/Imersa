// Ledger: o ÚNICO caminho para gravar estado e eventos sincronizáveis do aluno
// (cards, progresso da dose, ajustes, revisões, imersão, marcas de fala).
//
// As regras que a sincronização depende — que se repetiam à mão em ~15 lugares —
// vivem aqui e só aqui:
//   • estado (cards / doseProgress / settings) é carimbado com `updatedAt` de
//     agora, para vencer o last-write-wins quando é a versão mais nova;
//   • ler-alterar-gravar acontece dentro de `db.transaction("rw")` (`updateState`);
//   • apagar grava o tombstone NA MESMA transação (`removeState`, `removeEvent`);
//   • chave `local:` (config deste aparelho) é carimbada, mas nunca gera
//     tombstone nem agenda sincronização — não sai do aparelho;
//   • toda escrita sincronizável agenda o sync (`scheduleSync`), então quem
//     chama não precisa lembrar.
//
// Eventos (revisão, imersão, marca) são imutáveis: não há `updateEvent`; corrigir
// é apagar com tombstone e criar outro.
//
// Fora do ledger só `db.ts` (reset, wipe e importação de backup) e `sync.ts`
// (aplica o que veio do servidor, preservando o carimbo de origem) gravam direto.
// `test/unit/ledgerGuard.test.ts` falha se outro módulo tentar.
import {
  db,
  LOCAL_SETTING,
  type CardRecord,
  type DoseProgressRecord,
  type ImmersionRecord,
  type MarkRecord,
  type ReviewRecord,
  type SettingRecord,
  type SyncKind,
} from "./db";
import { scheduleSync } from "./sync";

export type StateKind = "card" | "doseProgress" | "setting";
export type EventKind = "review" | "immersion" | "mark";

interface StateRecords {
  card: CardRecord;
  doseProgress: DoseProgressRecord;
  setting: SettingRecord;
}
interface EventRecords {
  review: ReviewRecord;
  immersion: ImmersionRecord;
  mark: MarkRecord;
}

const isLocalKey = (key: string) => key.startsWith(LOCAL_SETTING);

/** Tabela e identidade de cada tipo de estado (a `key`/`doseId`/`uid` do registro). */
function stateTable(kind: StateKind) {
  switch (kind) {
    case "card":
      return { table: db.cards, idOf: (r: CardRecord) => r.key, syncable: () => true };
    case "doseProgress":
      return { table: db.doseProgress, idOf: (r: DoseProgressRecord) => r.doseId, syncable: () => true };
    case "setting":
      return { table: db.settings, idOf: (r: SettingRecord) => r.key, syncable: (id: string) => !isLocalKey(id) };
  }
}

function eventTable(kind: EventKind) {
  switch (kind) {
    case "review":
      return db.reviewLog;
    case "immersion":
      return db.immersionLog;
    case "mark":
      return db.lineMarks;
  }
}

async function tombstone(kind: SyncKind, id: string): Promise<void> {
  await db.tombstones.put({ tid: `${kind}:${id}`, kind, id, deletedAt: Date.now() });
}

/** Grava um registro de estado com `updatedAt` de agora. Devolve o gravado. */
export async function putState<K extends StateKind>(
  kind: K,
  rec: Omit<StateRecords[K], "updatedAt">,
): Promise<StateRecords[K]> {
  const spec = stateTable(kind) as { table: { put(r: unknown): Promise<unknown> }; syncable: (id: string) => boolean; idOf: (r: unknown) => string };
  const saved = { ...rec, updatedAt: Date.now() } as StateRecords[K];
  await spec.table.put(saved);
  if (spec.syncable(spec.idOf(saved))) scheduleSync();
  return saved;
}

/**
 * Ler-alterar-gravar de UM registro de estado, numa transação. `fn` recebe o
 * valor atual do banco (ou `undefined`) e devolve o novo, ou `null` para não
 * gravar nada. Duas chamadas no mesmo tick não se apagam (a segunda lê o que a
 * primeira gravou). Devolve o registro gravado (ou o atual, se não houve escrita).
 */
export async function updateState<K extends StateKind>(
  kind: K,
  id: string,
  fn: (cur: StateRecords[K] | undefined) => Omit<StateRecords[K], "updatedAt"> | null,
): Promise<StateRecords[K] | undefined> {
  const spec = stateTable(kind) as unknown as {
    table: { get(id: string): Promise<StateRecords[K] | undefined>; put(r: unknown): Promise<unknown> };
    syncable: (id: string) => boolean;
  };
  return db.transaction("rw", spec.table as never, async () => {
    const cur = await spec.table.get(id);
    const next = fn(cur);
    if (!next) return cur;
    const saved = { ...next, updatedAt: Date.now() } as StateRecords[K];
    await spec.table.put(saved);
    if (spec.syncable(id)) scheduleSync();
    return saved;
  }) as Promise<StateRecords[K] | undefined>;
}

/** Apaga um registro de estado e, se ele sincroniza, grava o tombstone junto. */
export async function removeState(kind: StateKind, id: string): Promise<void> {
  const spec = stateTable(kind) as unknown as { table: { delete(id: string): Promise<void> }; syncable: (id: string) => boolean };
  await db.transaction("rw", [spec.table as never, db.tombstones], async () => {
    await spec.table.delete(id);
    if (spec.syncable(id)) await tombstone(kind, id);
  });
  if (spec.syncable(id)) scheduleSync();
}

/**
 * Grava vários registros de estado de uma vez: um carimbo, um `bulkPut`, um
 * agendamento de sincronização (em vez de um por registro).
 */
export async function putStates<K extends StateKind>(
  kind: K,
  recs: Omit<StateRecords[K], "updatedAt">[],
): Promise<void> {
  if (!recs.length) return;
  const spec = stateTable(kind) as unknown as {
    table: { bulkPut(r: unknown[]): Promise<unknown> };
    syncable: (id: string) => boolean;
    idOf: (r: unknown) => string;
  };
  const at = Date.now();
  const saved = recs.map((rec) => ({ ...rec, updatedAt: at }));
  await spec.table.bulkPut(saved);
  if (saved.some((r) => spec.syncable(spec.idOf(r)))) scheduleSync();
}

/** Ajuste (`settings`): mesma regra de `putState`. Chave `local:` não sincroniza. */
export async function setSetting<T>(key: string, value: T): Promise<void> {
  await putState("setting", { key, value });
}

/** Acrescenta um evento imutável (revisão, imersão, marca). */
export async function appendEvent<K extends EventKind>(kind: K, ev: EventRecords[K]): Promise<void> {
  await eventTable(kind).add(ev as never);
  scheduleSync();
}

/** Apaga um evento e grava o tombstone do tipo certo, na mesma transação. */
export async function removeEvent(kind: EventKind, uid: string): Promise<void> {
  await db.transaction("rw", [eventTable(kind) as never, db.tombstones], async () => {
    await eventTable(kind).delete(uid);
    await tombstone(kind, uid);
  });
  scheduleSync();
}
