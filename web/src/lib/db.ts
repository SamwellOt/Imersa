// Local persistence (IndexedDB via Dexie): SRS card states, review log, dose
// progress, immersion log, and settings. Everything about the learner lives here.
//
// O banco é a fonte da verdade LOCAL e funciona 100% offline. A sincronização
// (lib/sync.ts) só espelha estas tabelas num servidor para que desktop e celular
// vejam o mesmo progresso. Para o merge funcionar sem servidor "esperto", cada
// tabela tem uma forma:
//   • reviewLog / immersionLog → EVENTOS imutáveis com id global (`uid`).
//     Merge = união. Contadores do dia saem daqui (derivados), nunca somados à
//     mão — dois aparelhos somando o mesmo contador dariam número errado.
//   • cards / doseProgress / settings → ESTADO, com `updatedAt`: last-write-wins.
//   • tombstones → apagar também precisa viajar (senão o servidor "ressuscita"
//     o que você acabou de apagar no reset).
import Dexie, { type Table } from "dexie";
import type { State } from "ts-fsrs";
import { dayKey, snapDueToDay } from "./utils";

/** Id global de evento — precisa ser único ENTRE aparelhos, não só neste. */
export function newUid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** One SRS card = one mined word, keyed globally by `${doseId}::${cardId}`. */
export interface CardRecord {
  key: string; // `${doseId}::${cardId}`
  doseId: string;
  cardId: string;
  language: string;
  // FSRS scheduling state (serialized ts-fsrs Card)
  due: number; // epoch ms
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: State;
  last_review?: number; // epoch ms
  /** Em que passo de (re)aprendizado o card está (ts-fsrs ≥ 5). `undefined` =
   *  registro anterior aos passos, lido como 0. */
  learning_steps?: number;
  // NÃO acrescente campo do ts-fsrs aqui sem ensinar `toFsrs`/`applyFsrs` a
  // ler e gravar ele: campo declarado e não convertido é perdido a cada nota,
  // e o agendamento passa a errar em silêncio.
  // bookkeeping
  introducedAt: number;
  /** Suspenso: fora de toda fila até ser reativado (Anki "suspend"). */
  suspended?: boolean;
  /** Adiado: fora das filas até este instante (Anki "bury" = até o próximo dia
   *  de estudo). Passado o instante o campo é só ruído e é ignorado. */
  buriedUntil?: number;
  /** Faixa de vocabulário da palavra (TOPIK "A"|"B"|"C"), copiada do dose.json
   *  quando o card nasce. `undefined` = registro antigo, ainda não preenchido
   *  (ver `backfillCardTiers`); `null` = palavra fora da tabela do idioma. */
  topikLevel?: string | null;
  /** «Já sei»: a palavra não entra em fila nenhuma e conta como conhecida (legenda,
   *  compreensão, nível). Não gasta a cota de novos. Ver `markKnown`. */
  known?: boolean;
  /** De onde o card veio, quando não é um dos 20 da dose: "extra" = "+ card" pela
   *  legenda; "sentence" = card de frase i+1. Nenhum dos dois conta no teto de
   *  palavras novas do dia. */
  origin?: "extra" | "sentence";
  updatedAt: number; // last-write-wins na sincronização
}

export interface ReviewRecord {
  uid: string; // id global do evento
  key: string;
  doseId: string;
  language: string;
  rating: number; // 1..4
  reviewedAt: number; // epoch ms
  day: string; // YYYY-MM-DD (local)
  elapsedMs: number; // time spent on the card
  state: State; // state at review time
  /** Copiado do card (`CardRecord.origin`): nota em card extra/de frase não conta
   *  no teto de palavras novas. */
  origin?: "extra" | "sentence";
}

/**
 * «Não entendi» numa fala da imersão — EVENTO (id global, merge = união), como a
 * revisão. Desmarcar = apagar com tombstone. É a compreensão REAL da lição, para
 * comparar com a prevista pelo vocabulário (`/progress`) e calibrar a escada de
 * dificuldade da pipeline (`ladder.py --feedback`).
 */
export interface MarkRecord {
  uid: string;
  language: string;
  doseId: string;
  segmentId: string;
  day: string;
  at: number;
}

/** Minutos de imersão como EVENTO (e não contador), para somar entre aparelhos. */
export interface ImmersionRecord {
  uid: string;
  language: string;
  day: string; // YYYY-MM-DD (local)
  ms: number;
  at: number; // epoch ms
  /** Em que lição o tempo foi assistido (`/progress` → compreensão por lição).
   *  Ausente em evento antigo: ele conta no total do idioma, não numa lição. */
  doseId?: string;
}

export type DosePhase = "prime" | "immersion" | "review";

export interface DoseProgressRecord {
  doseId: string;
  language: string;
  phases: DosePhase[]; // completed phases
  completed: boolean;
  /** Legado: a posição do vídeo agora mora em `local:mediaPos:<doseId>` (ver
   *  `saveMediaPosition`). Só é lida quando não há valor local. */
  lastMediaPositionMs: number;
  startedAt: number;
  completedAt?: number;
  updatedAt: number;
}

export interface SettingRecord {
  key: string;
  value: unknown;
  updatedAt?: number;
}

/** O que foi apagado aqui, para o outro aparelho apagar também. */
export type SyncKind = "card" | "review" | "doseProgress" | "immersion" | "setting" | "mark";

export interface TombstoneRecord {
  tid: string; // `${kind}:${id}`
  kind: SyncKind;
  id: string;
  deletedAt: number;
}

/** Agregado por dia — DERIVADO dos eventos, nunca armazenado. */
export interface DailyStat {
  day: string;
  language: string;
  reviews: number;
  newCards: number;
  immersionMs: number;
  dosesCompleted: number;
}

/** Formato antigo (v1), só para a migração. */
interface LegacyDailyStat {
  day: string;
  language: string;
  reviews: number;
  newCards: number;
  immersionMs: number;
  dosesCompleted: number;
}
interface LegacyReview extends Omit<ReviewRecord, "uid"> {
  id?: number;
}

class ImersaDB extends Dexie {
  cards!: Table<CardRecord, string>;
  reviewLog!: Table<ReviewRecord, string>;
  immersionLog!: Table<ImmersionRecord, string>;
  doseProgress!: Table<DoseProgressRecord, string>;
  tombstones!: Table<TombstoneRecord, string>;
  settings!: Table<SettingRecord, string>;
  lineMarks!: Table<MarkRecord, string>;

  constructor() {
    super("imersa");
    this.version(1).stores({
      cards: "key, doseId, language, due, state, [language+due]",
      reviews: "++id, key, doseId, language, day, reviewedAt",
      doseProgress: "doseId, language, completed",
      dailyStats: "[day+language], day, language",
      settings: "key",
    });
    // v2 — eventos com id global + tombstones. As tabelas antigas continuam de pé
    // durante esta versão porque é delas que a migração lê.
    this.version(2)
      .stores({
        cards: "key, doseId, language, due, state, [language+due], updatedAt",
        reviewLog: "uid, key, doseId, language, day, reviewedAt",
        immersionLog: "uid, language, day, at",
        doseProgress: "doseId, language, completed, updatedAt",
        tombstones: "tid, deletedAt",
        settings: "key",
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        await tx.table("cards").toCollection().modify((c: CardRecord) => {
          c.updatedAt = c.updatedAt ?? c.last_review ?? c.introducedAt ?? now;
        });
        await tx.table("doseProgress").toCollection().modify((p: DoseProgressRecord) => {
          p.updatedAt = p.updatedAt ?? now;
        });
        const olds = (await tx.table("reviews").toArray()) as LegacyReview[];
        if (olds.length) {
          await tx.table("reviewLog").bulkAdd(
            olds.map(({ id: _id, ...r }) => ({ ...r, uid: newUid() } as ReviewRecord)),
          );
        }
        // o tempo de imersão do formato antigo vira um evento por dia, para o
        // histórico de streak não zerar na migração
        const stats = (await tx.table("dailyStats").toArray()) as LegacyDailyStat[];
        const carried = stats.filter((s) => s.immersionMs > 0);
        if (carried.length) {
          await tx.table("immersionLog").bulkAdd(
            carried.map((s) => ({
              uid: newUid(), language: s.language, day: s.day, ms: s.immersionMs,
              at: new Date(`${s.day}T12:00:00`).getTime() || now,
            })),
          );
        }
      });
    // v3 — só então as tabelas v1 somem
    this.version(3).stores({ reviews: null, dailyStats: null });
    // v4 — vencimento POR DIA (Anki): o `due` de quem já está em dias vira o
    // início do dia de estudo em que caía, em vez da hora exata da revisão
    // (ver `snapDueToDay`). `updatedAt` novo, senão a mudança perde o
    // last-write-wins na sincronização e nunca sai deste aparelho.
    this.version(4)
      .stores({})
      .upgrade(async (tx) => {
        const now = Date.now();
        await tx.table("cards").toCollection().modify((c: CardRecord) => {
          const due = snapDueToDay(c.due, c.last_review, c.scheduled_days);
          if (due !== c.due) {
            c.due = due;
            c.updatedAt = now;
          }
        });
      });
    // v5 — «não entendi» por fala (evento)
    this.version(5).stores({ lineMarks: "uid, language, doseId, at" });
  }
}

export const db = new ImersaDB();

// ---- typed settings helpers ----

/** Prefixo de chave que NUNCA sai deste aparelho (código de sync, id do device). */
export const LOCAL_SETTING = "local:";
/** Estado da sincronização (cursor do servidor, último envio) — só deste aparelho. */
export const SYNC_STATE_KEY = `${LOCAL_SETTING}syncState`;
/**
 * Momento da última importação de backup. Tombstones de EVENTO vindos do servidor
 * mais velhos que isto são ignorados: um reset feito antes não pode apagar o que
 * o aluno acabou de restaurar de propósito.
 */
export const IMPORTED_AT_KEY = `${LOCAL_SETTING}importedAt`;
/** Sessão da conta (token + usuário). Só deste aparelho — ver lib/auth.ts. */
export const AUTH_KEY = `${LOCAL_SETTING}auth`;
/** A quem pertence o progresso guardado neste aparelho (id da conta; vazio =
 *  ninguém ainda). Entrar com OUTRA conta limpa antes, senão o progresso de um
 *  aluno subiria para a conta do outro. */
export const DATA_OWNER_KEY = `${LOCAL_SETTING}dataOwner`;
/** Id deste aparelho (para o sync não devolver o eco do que ele mesmo subiu). */
export const DEVICE_ID_KEY = `${LOCAL_SETTING}deviceId`;

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rec = await db.settings.get(key);
  return rec ? (rec.value as T) : fallback;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await db.settings.put({ key, value, updatedAt: Date.now() });
}

// ---- tombstones ----

export async function tombstone(kind: SyncKind, id: string): Promise<void> {
  await db.tombstones.put({ tid: `${kind}:${id}`, kind, id, deletedAt: Date.now() });
}

async function tombstoneMany(kind: SyncKind, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const deletedAt = Date.now();
  await db.tombstones.bulkPut(ids.map((id) => ({ tid: `${kind}:${id}`, kind, id, deletedAt })));
}

// ---- derived daily aggregates ----
// Vêm dos eventos, então dois aparelhos que estudaram no mesmo dia SOMAM em vez
// de sobrescrever um ao outro.

export async function dailyStats(language: string): Promise<Map<string, DailyStat>> {
  const [revs, imm, prog] = await Promise.all([
    db.reviewLog.where("language").equals(language).toArray(),
    db.immersionLog.where("language").equals(language).toArray(),
    db.doseProgress.where("language").equals(language).toArray(),
  ]);
  const out = new Map<string, DailyStat>();
  const at = (day: string) => {
    let s = out.get(day);
    if (!s) out.set(day, (s = { day, language, reviews: 0, newCards: 0, immersionMs: 0, dosesCompleted: 0 }));
    return s;
  };
  for (const r of revs) {
    const s = at(r.day);
    s.reviews++;
    if (r.state === 0) s.newCards++; // State.New
  }
  for (const i of imm) at(i.day).immersionMs += i.ms;
  for (const p of prog) {
    if (p.completed && p.completedAt) at(dayKey(new Date(p.completedAt))).dosesCompleted++;
  }
  return out;
}

// ---- export / import ----

export interface ExportBundle {
  app: "imersa";
  version: number;
  exportedAt: string;
  cards: CardRecord[];
  reviews: ReviewRecord[];
  immersion: ImmersionRecord[];
  doseProgress: DoseProgressRecord[];
  settings: SettingRecord[];
  /** Ausente em backup antigo. */
  marks?: MarkRecord[];
}

export async function exportAll(): Promise<ExportBundle> {
  const [cards, reviews, immersion, doseProgress, settings, marks] = await Promise.all([
    db.cards.toArray(),
    db.reviewLog.toArray(),
    db.immersionLog.toArray(),
    db.doseProgress.toArray(),
    db.settings.toArray(),
    db.lineMarks.toArray(),
  ]);
  return {
    app: "imersa",
    version: 2,
    exportedAt: new Date().toISOString(),
    cards,
    reviews,
    immersion,
    doseProgress,
    settings: settings.filter((s) => !s.key.startsWith(LOCAL_SETTING)),
    marks,
  };
}

/**
 * Restaura um backup. O que foi restaurado é o que o aluno quer — então o estado
 * (cards, progresso, ajustes) recebe `updatedAt` de AGORA para vencer o
 * last-write-wins contra o servidor, o cursor da sincronização volta a zero
 * (tudo sobe de novo e tudo desce de novo) e os tombstones locais pendentes
 * somem (eram de um estado que não existe mais). Antes os carimbos antigos eram
 * preservados: nada subia (`updatedAt` < último envio) e a primeira descida do
 * servidor desfazia a importação inteira.
 */
export async function importAll(bundle: ExportBundle): Promise<void> {
  // `cards`/`doseProgress` são obrigatórios: sem a checagem, um JSON qualquer
  // passava daqui e estourava no meio da transação com "Cannot read properties
  // of undefined" — nada era gravado, mas a mensagem não dizia o porquê.
  if (
    bundle?.app !== "imersa" ||
    !Array.isArray(bundle.cards) ||
    !Array.isArray(bundle.doseProgress)
  ) {
    throw new Error("Arquivo inválido: não é um backup do Imersa.");
  }
  const now = Date.now();
  await db.transaction(
    "rw",
    [db.cards, db.reviewLog, db.immersionLog, db.doseProgress, db.settings, db.tombstones, db.lineMarks],
    async () => {
      await Promise.all([
        db.cards.clear(),
        db.reviewLog.clear(),
        db.immersionLog.clear(),
        db.doseProgress.clear(),
        db.tombstones.clear(),
        db.lineMarks.clear(),
      ]);
      // backup de antes do vencimento por dia: traz o `due` para a régua atual
      await db.cards.bulkPut(
        bundle.cards.map((c) => ({
          ...c,
          due: snapDueToDay(c.due, c.last_review, c.scheduled_days),
          updatedAt: now,
        })),
      );
      await db.reviewLog.bulkPut(
        (bundle.reviews ?? []).map((r) => ({ ...r, uid: r.uid ?? newUid() })),
      );
      await db.immersionLog.bulkPut(bundle.immersion ?? []);
      await db.lineMarks.bulkPut(bundle.marks ?? []);
      await db.doseProgress.bulkPut(bundle.doseProgress.map((p) => ({ ...p, updatedAt: now })));
      for (const s of bundle.settings ?? []) {
        if (!s.key.startsWith(LOCAL_SETTING)) await db.settings.put({ ...s, updatedAt: now });
      }
      await db.settings.put({ key: IMPORTED_AT_KEY, value: now, updatedAt: now });
      // Cursor zerado + MESMO id de aparelho = o servidor nunca devolve as linhas
      // que este aparelho subiu antes (supressão de eco): revisões feitas aqui
      // depois do backup ficavam na conta e nos outros aparelhos, mas não aqui.
      // Como no `wipeLocalData`: restaurado = aparelho novo.
      await db.settings.delete(DEVICE_ID_KEY);
      await db.settings.put({
        key: SYNC_STATE_KEY,
        value: { cursor: 0, pushedAt: 0, lastOkAt: 0, lastError: null },
        updatedAt: now,
      });
    },
  );
}

/** Wipe SRS + progress for a single language (keeps other languages + prefs). */
export async function resetLanguage(language: string): Promise<void> {
  const [cards, revs, imm, prog, marks] = await Promise.all([
    db.cards.where("language").equals(language).toArray(),
    db.reviewLog.where("language").equals(language).toArray(),
    db.immersionLog.where("language").equals(language).toArray(),
    db.doseProgress.where("language").equals(language).toArray(),
    db.lineMarks.where("language").equals(language).toArray(),
  ]);
  // posição do vídeo (local) das doses deste idioma — o id da dose começa pelo idioma
  const posKeys = (await db.settings.toCollection().primaryKeys())
    .filter((k) => k.startsWith(`${LOCAL_SETTING}mediaPos:${language}-`));
  await db.transaction("rw", [db.cards, db.reviewLog, db.immersionLog, db.doseProgress, db.tombstones, db.settings, db.lineMarks], async () => {
    await db.settings.bulkDelete(posKeys);
    await db.lineMarks.bulkDelete(marks.map((m) => m.uid));
    await tombstoneMany("mark", marks.map((m) => m.uid));
    await db.cards.bulkDelete(cards.map((c) => c.key));
    await db.reviewLog.bulkDelete(revs.map((r) => r.uid));
    await db.immersionLog.bulkDelete(imm.map((i) => i.uid));
    await db.doseProgress.bulkDelete(prog.map((p) => p.doseId));
    // o apagar precisa viajar, senão a próxima sincronização traz tudo de volta
    await tombstoneMany("card", cards.map((c) => c.key));
    await tombstoneMany("review", revs.map((r) => r.uid));
    await tombstoneMany("immersion", imm.map((i) => i.uid));
    await tombstoneMany("doseProgress", prog.map((p) => p.doseId));
  });
}

export async function resetAll(): Promise<void> {
  const [cards, revs, imm, prog, settings, marks] = await Promise.all([
    db.cards.toArray(),
    db.reviewLog.toArray(),
    db.immersionLog.toArray(),
    db.doseProgress.toArray(),
    db.settings.toArray(),
    db.lineMarks.toArray(),
  ]);
  await db.transaction("rw", [db.cards, db.reviewLog, db.immersionLog, db.doseProgress, db.settings, db.tombstones, db.lineMarks], async () => {
    await Promise.all([
      db.cards.clear(),
      db.reviewLog.clear(),
      db.immersionLog.clear(),
      db.doseProgress.clear(),
      db.lineMarks.clear(),
    ]);
    await tombstoneMany("mark", marks.map((m) => m.uid));
    const syncable = settings.filter((s) => !s.key.startsWith(LOCAL_SETTING));
    const posKeys = settings.filter((s) => s.key.startsWith(`${LOCAL_SETTING}mediaPos:`));
    await db.settings.bulkDelete([...syncable, ...posKeys].map((s) => s.key));
    await tombstoneMany("card", cards.map((c) => c.key));
    await tombstoneMany("review", revs.map((r) => r.uid));
    await tombstoneMany("immersion", imm.map((i) => i.uid));
    await tombstoneMany("doseProgress", prog.map((p) => p.doseId));
    await tombstoneMany("setting", syncable.map((s) => s.key));
  });
}

/** Há progresso neste aparelho? (decide se vale oferecer "levar para a conta") */
export async function localProgressSummary(): Promise<{ cards: number; reviews: number }> {
  const [cards, reviews] = await Promise.all([db.cards.count(), db.reviewLog.count()]);
  return { cards, reviews };
}

/**
 * Esvazia o progresso deste aparelho SEM tombstones — é o "sair da conta" (ou
 * entrar com outra). Nada aqui deve viajar: a conta continua inteira no
 * servidor, só este aparelho deixa de tê-la.
 *
 * O id do aparelho vai junto, de propósito: o servidor não devolve ao remetente
 * as linhas que ele mesmo escreveu (supressão de eco), então um aparelho limpo
 * que entrasse de novo com o MESMO id nunca receberia de volta o que tinha
 * subido. Limpo = aparelho novo.
 */
export async function wipeLocalData(keep: string[] = []): Promise<void> {
  const keepSet = new Set(keep);
  await db.transaction("rw", [db.cards, db.reviewLog, db.immersionLog, db.doseProgress, db.settings, db.tombstones, db.lineMarks], async () => {
    await Promise.all([
      db.cards.clear(),
      db.reviewLog.clear(),
      db.immersionLog.clear(),
      db.doseProgress.clear(),
      db.tombstones.clear(),
      db.lineMarks.clear(),
    ]);
    const keys = (await db.settings.toCollection().primaryKeys()).filter((k) => !keepSet.has(k));
    await db.settings.bulkDelete(keys);
  });
}
