// Sincronização entre aparelhos (desktop ↔ celular).
//
// O app continua **offline-first**: tudo é gravado no IndexedDB primeiro e a
// sincronização é um espelho oportunista. Ficar sem rede nunca bloqueia estudar;
// quando a rede volta, o que faltou sobe.
//
// Como o merge funciona (o servidor é burro de propósito — ver server/sync-store.mjs):
//   • sobe tudo que mudou desde o último envio (`updatedAt > pushedAt`) + os
//     tombstones (o que foi apagado aqui);
//   • baixa tudo com `seq` maior que o último visto — o `seq` é um relógio do
//     servidor, então não dependemos de os relógios dos aparelhos baterem;
//   • ao aplicar o que veio, `updatedAt` decide quem ganha em cards/progresso, e
//     eventos (review/imersão) são só unidos pelo `uid`.
import {
  db,
  getSetting,
  newUid,
  setSetting,
  LOCAL_SETTING,
  SYNC_STATE_KEY,
  IMPORTED_AT_KEY,
  AUTH_KEY,
  DEVICE_ID_KEY,
  type CardRecord,
  type DoseProgressRecord,
  type ImmersionRecord,
  type ReviewRecord,
  type SyncKind,
} from "./db";
import { snapDueToDay } from "./utils";

const CFG_KEY = `${LOCAL_SETTING}sync`;
const STATE_KEY = SYNC_STATE_KEY;
const DEVICE_KEY = DEVICE_ID_KEY;

/** Disparado quando o servidor recusa a sessão da conta (401): lib/auth.ts
 *  ouve e derruba o estado "logado" — a tela de entrar aparece sozinha. */
export const SESSION_EXPIRED_EVENT = "imersa:session-expired";

/** Legado: sincronização por código, sem cadastro. A conta (lib/auth.ts) é o
 *  caminho normal; o código continua aceito para aparelhos que ainda o usam. */
export interface SyncConfig {
  enabled: boolean;
  /** Vazio = mesma origem de onde o app foi servido (o caso normal). */
  url: string;
  code: string;
}

export interface SyncState {
  /** Último `seq` do servidor já aplicado aqui. */
  cursor: number;
  /** Momento do último envio bem-sucedido — o corte do "o que mudou desde então". */
  pushedAt: number;
  lastOkAt: number;
  lastError: string | null;
}

const DEFAULT_CFG: SyncConfig = { enabled: false, url: "", code: "" };
const DEFAULT_STATE: SyncState = { cursor: 0, pushedAt: 0, lastOkAt: 0, lastError: null };

export const getSyncConfig = () => getSetting<SyncConfig>(CFG_KEY, DEFAULT_CFG);
export const getSyncState = () => getSetting<SyncState>(STATE_KEY, DEFAULT_STATE);

/** Recomeça do zero com o servidor: tudo sobe de novo e tudo desce de novo.
 *  É o que se faz ao trocar de conta (o `seq` de uma não tem relação com o da outra). */
export const resetSyncState = () => setSetting(STATE_KEY, { ...DEFAULT_STATE });

interface Credential {
  header: string;
  /** Sessão de conta (vs. código legado): só ela vira "sessão expirada" num 401. */
  session: boolean;
  url: string;
}

/** A credencial em vigor: a sessão da conta tem preferência sobre o código. */
async function credential(): Promise<Credential | null> {
  const auth = await getSetting<{ token?: string } | null>(AUTH_KEY, null);
  if (auth?.token) return { header: `Bearer ${auth.token}`, session: true, url: "" };
  const cfg = await getSyncConfig();
  if (cfg.enabled && cfg.code.length >= MIN_CODE_LENGTH) {
    return { header: `Bearer ${cfg.code}`, session: false, url: cfg.url || "" };
  }
  return null;
}

export async function isSyncEnabled(): Promise<boolean> {
  return (await credential()) !== null;
}

export async function setSyncConfig(patch: Partial<SyncConfig>): Promise<SyncConfig> {
  const prev = await getSyncConfig();
  const next = { ...prev, ...patch };
  await setSetting(CFG_KEY, next);
  // trocar de conta invalida o cursor: o `seq` do servidor novo não tem relação
  // com o do antigo, então recomeçamos do zero e puxamos tudo. Só quando o valor
  // MUDA de fato — o campo de código salva a cada blur, e resetar ali fazia o
  // app rebaixar a conta inteira do servidor sem nenhum motivo.
  if (next.code !== prev.code || next.url !== prev.url) {
    await setSetting(STATE_KEY, { ...DEFAULT_STATE, pushedAt: 0 });
  }
  return next;
}

export async function deviceId(): Promise<string> {
  let id = await getSetting<string>(DEVICE_KEY, "");
  if (!id) {
    id = newUid();
    await setSetting(DEVICE_KEY, id);
  }
  return id;
}

/** Código novo, legível e longo o bastante para não ser adivinhado. */
export function generateCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // sem 0/o/1/l/i
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars
    .slice(8, 12).join("")}-${chars.slice(12, 16).join("")}`;
}

export const MIN_CODE_LENGTH = 12;

// ---- montagem do lote de subida ----

interface Change {
  kind: SyncKind;
  id: string;
  updatedAt: number;
  deleted?: boolean;
  value?: unknown;
}

async function localChanges(since: number): Promise<Change[]> {
  const [cards, progress, reviews, immersion, settings, tombs] = await Promise.all([
    db.cards.filter((c) => (c.updatedAt ?? 0) > since).toArray(),
    db.doseProgress.filter((p) => (p.updatedAt ?? 0) > since).toArray(),
    db.reviewLog.filter((r) => r.reviewedAt > since).toArray(),
    db.immersionLog.filter((i) => i.at > since).toArray(),
    db.settings.filter((s) => !s.key.startsWith(LOCAL_SETTING) && (s.updatedAt ?? 0) > since).toArray(),
    db.tombstones.filter((t) => t.deletedAt > since).toArray(),
  ]);
  return [
    ...cards.map((c) => ({ kind: "card" as const, id: c.key, updatedAt: c.updatedAt, value: c })),
    ...progress.map((p) => ({ kind: "doseProgress" as const, id: p.doseId, updatedAt: p.updatedAt, value: p })),
    ...reviews.map((r) => ({ kind: "review" as const, id: r.uid, updatedAt: r.reviewedAt, value: r })),
    ...immersion.map((i) => ({ kind: "immersion" as const, id: i.uid, updatedAt: i.at, value: i })),
    ...settings.map((s) => ({ kind: "setting" as const, id: s.key, updatedAt: s.updatedAt ?? 0, value: s.value })),
    ...tombs.map((t) => ({ kind: t.kind, id: t.id, updatedAt: t.deletedAt, deleted: true })),
  ];
}

// ---- aplicação do que veio do servidor ----

interface Incoming {
  kind: SyncKind;
  id: string;
  seq: number;
  updatedAt: number;
  deleted: boolean;
  value: unknown;
}

async function applyRemote(records: Incoming[]): Promise<number> {
  if (!records.length) return 0;
  let applied = 0;
  const importedAt = await getSetting<number>(IMPORTED_AT_KEY, 0);
  await db.transaction(
    "rw",
    db.cards, db.reviewLog, db.immersionLog, db.doseProgress, db.settings,
    async () => {
      for (const r of records) {
        if (r.deleted) {
          // Estado: o tombstone é uma escrita como outra qualquer e obedece ao
          // last-write-wins — uma versão local MAIS NOVA que o apagar fica.
          // Antes o apagar vencia sempre: um reset num aparelho engolia o que
          // o outro tinha estudado offline, que depois subia e ressuscitava
          // lá — inconsistência nos dois lados.
          // Evento: o tombstone é definitivo, salvo para o que foi restaurado
          // de um backup DEPOIS dele (ver `IMPORTED_AT_KEY`).
          if (r.kind === "card" || r.kind === "doseProgress" || r.kind === "setting") {
            const table = r.kind === "card" ? db.cards : r.kind === "doseProgress" ? db.doseProgress : db.settings;
            const cur = (await table.get(r.id)) as { updatedAt?: number } | undefined;
            if (cur && (cur.updatedAt ?? 0) > r.updatedAt) continue;
            await table.delete(r.id);
          } else {
            if (r.updatedAt < importedAt) continue;
            if (r.kind === "review") await db.reviewLog.delete(r.id);
            else await db.immersionLog.delete(r.id);
          }
          applied++;
          continue;
        }
        if (r.kind === "card") {
          const inc = r.value as CardRecord;
          const cur = await db.cards.get(r.id);
          // o local só perde se for realmente mais velho
          if (cur && (cur.updatedAt ?? 0) > (inc.updatedAt ?? r.updatedAt)) continue;
          await db.cards.put({
            ...inc,
            // aparelho com app antigo ainda manda hora exata: régua por dia aqui
            due: snapDueToDay(inc.due, inc.last_review, inc.scheduled_days),
            updatedAt: inc.updatedAt ?? r.updatedAt,
          });
        } else if (r.kind === "doseProgress") {
          const inc = r.value as DoseProgressRecord;
          const cur = await db.doseProgress.get(r.id);
          if (cur && (cur.updatedAt ?? 0) > (inc.updatedAt ?? r.updatedAt)) continue;
          await db.doseProgress.put({ ...inc, updatedAt: inc.updatedAt ?? r.updatedAt });
        } else if (r.kind === "review") {
          await db.reviewLog.put(r.value as ReviewRecord);
        } else if (r.kind === "immersion") {
          await db.immersionLog.put(r.value as ImmersionRecord);
        } else if (r.kind === "setting") {
          if (r.id.startsWith(LOCAL_SETTING)) continue; // nunca importar config local
          const cur = await db.settings.get(r.id);
          if (cur && (cur.updatedAt ?? 0) > r.updatedAt) continue;
          await db.settings.put({ key: r.id, value: r.value, updatedAt: r.updatedAt });
        }
        applied++;
      }
    },
  );
  return applied;
}

// ---- o ciclo ----

export interface SyncResult {
  ok: boolean;
  sent: number;
  received: number;
  error?: string;
}

/** Evento global: a UI se recarrega quando algo chega de outro aparelho. */
export const SYNC_EVENT = "imersa:synced";

let running: Promise<SyncResult> | null = null;
// Pediram sync enquanto um já rodava? O que foi gravado durante a subida não
// entrou no lote (o corte é `startedAt`): roda de novo logo em seguida, em vez
// de esperar o gatilho de 5 min.
let dirty = false;
const listeners = new Set<(r: SyncResult) => void>();

export function onSync(fn: (r: SyncResult) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

interface SyncOpts {
  /** Ao fechar a aba: pede ao navegador para terminar o envio mesmo depois de a
   *  página sumir (`fetch` sem isso é cancelado no `pagehide`). Só cabe em
   *  lotes pequenos — o limite do `keepalive` é 64 KB por origem. */
  keepalive?: boolean;
}

async function runSync(opts: SyncOpts = {}): Promise<SyncResult> {
  const cred = await credential();
  if (!cred) {
    return { ok: false, sent: 0, received: 0, error: "Sem conta: o progresso fica só neste aparelho." };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { ok: false, sent: 0, received: 0, error: "Sem conexão." };
  }
  const state = await getSyncState();
  const endpoint = `${cred.url.replace(/\/+$/, "")}/api/sync`;
  const startedAt = Date.now();
  const changes = await localChanges(state.pushedAt);

  let cursor = state.cursor;
  let received = 0;
  try {
    // páginas: o servidor corta a resposta e diz se sobrou (`hasMore`)
    let sentThisRound = changes;
    for (let round = 0; round < 50; round++) {
      const body = JSON.stringify({ since: cursor, deviceId: await deviceId(), changes: sentThisRound });
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: cred.header },
        body,
        keepalive: !!opts.keepalive && body.length < 60_000,
      });
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        if (res.status === 401 && cred.session && typeof dispatchEvent === "function") {
          dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
        }
        throw new Error(msg?.error || `Servidor respondeu ${res.status}.`);
      }
      const data = await res.json();
      received += await applyRemote(data.records ?? []);
      cursor = (data.records ?? []).reduce(
        (mx: number, r: Incoming) => Math.max(mx, r.seq), cursor,
      );
      sentThisRound = []; // as mudanças já foram entregues na primeira volta
      if (!data.hasMore) break;
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await setSetting(STATE_KEY, { ...state, cursor, lastError: error });
    return { ok: false, sent: 0, received, error };
  }

  // limpa os tombstones já entregues — eles só existem para viajar uma vez
  const delivered = await db.tombstones.filter((t) => t.deletedAt <= startedAt).toArray();
  if (delivered.length) await db.tombstones.bulkDelete(delivered.map((t) => t.tid));

  await setSetting(STATE_KEY, {
    cursor,
    // `startedAt` e não `Date.now()`: o que foi gravado DURANTE a subida precisa
    // entrar no próximo lote, senão some.
    pushedAt: startedAt,
    lastOkAt: Date.now(),
    lastError: null,
  });
  return { ok: true, sent: changes.length, received };
}

/** Sincroniza agora. Chamadas concorrentes compartilham a mesma execução. */
export function syncNow(opts?: SyncOpts): Promise<SyncResult> {
  if (running) {
    dirty = true;
    return running;
  }
  running = runSync(opts)
    .then((r) => {
      for (const fn of listeners) fn(r);
      if (typeof dispatchEvent === "function") {
        dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: r }));
      }
      return r;
    })
    .finally(() => {
      running = null;
      if (dirty) {
        dirty = false;
        scheduleSync(500);
      }
    });
  return running;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Sincroniza em breve — agrupa rajadas (avaliar 20 cards seguidos = 1 envio). */
export function scheduleSync(delayMs = 2500): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, delayMs);
}

const PERIOD_MS = 5 * 60 * 1000;

/** Liga os gatilhos automáticos. Chamado uma vez, na subida do app. */
export function startAutoSync(): void {
  void syncNow();
  setInterval(() => void syncNow(), PERIOD_MS);
  addEventListener("online", () => void syncNow());
  addEventListener("visibilitychange", () => {
    // voltar para a aba é o momento mais provável de o outro aparelho ter mexido
    if (document.visibilityState === "visible") void syncNow();
  });
  // fechar a aba/app: última chance de entregar o que acabou de ser estudado
  addEventListener("pagehide", () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      void syncNow({ keepalive: true });
    }
  });
}
