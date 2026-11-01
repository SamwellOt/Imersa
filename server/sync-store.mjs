// Armazenamento do sync: um SQLite (node:sqlite, embutido no Node 22 — sem
// dependências) com uma tabela única de registros versionados por conta.
//
// Modelo: cada registro é (account, kind, id) com um `seq` global crescente por
// conta. O cliente guarda o último `seq` que viu e pede só o que veio depois —
// é isso que faz a sincronização ser incremental e barata.
//
// Cada linha guarda também QUEM a escreveu por último (`device`). O `pull` pula
// as linhas do próprio remetente: sem isso o aparelho baixava de volta tudo que
// tinha acabado de subir, e o app tratava esse eco como "chegou coisa nova de
// outro aparelho" — recarregando todas as telas à toa.
//
// Regras de merge (o servidor é a autoridade):
//   • eventos imutáveis (review, immersion) → união; quem chega primeiro fica,
//     e um tombstone (deleted) nunca é desfeito (o "desfazer" do app cria um
//     evento novo, com uid novo, então não há ressurreição).
//   • estado mutável (card, doseProgress, setting) → last-write-wins pelo
//     `updatedAt` do cliente; empate desempata a favor do tombstone.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const KINDS = ["card", "review", "doseProgress", "immersion", "setting", "mark"];
const EVENT_KINDS = new Set(["review", "immersion", "mark"]);
/** Teto de registros por resposta — mantém o payload previsível em conexões ruins. */
export const PAGE = 2000;
/** Relógio do aparelho pode estar adiantado: sem teto, um `updatedAt` no futuro
 *  venceria o last-write-wins para sempre. Além disto, o servidor usa a própria hora. */
const MAX_SKEW_MS = 5 * 60_000;

// ---- limites de armazenamento (auditoria de 31/10/2026) ----
// Sem eles, qualquer conta (cadastro custa pouco) enchia o disco: 12 MB por
// pedido, pedidos sem fim. Os tetos ficam muito acima do uso real (a conta do
// aluno tinha 2.802 registros e o maior com 360 bytes).
/** Registro com `id` ou `value` maior que isto é ignorado (como item malformado). */
export const MAX_ID_LEN = 200;
export const MAX_VALUE_BYTES = 256 * 1024;
/** Cota por conta: registros (tombstones contam) e bytes de id + json. */
const QUOTA_RECORDS = Number(process.env.IMERSA_QUOTA_RECORDS) || 300_000;
const QUOTA_BYTES = Number(process.env.IMERSA_QUOTA_BYTES) || 100 * 1024 * 1024;

/** O lote faria a conta passar da cota: nada dele é gravado (507). */
export class QuotaError extends Error {
  constructor() {
    super("Cota de armazenamento da conta atingida. Nada deste envio foi gravado.");
    this.status = 507;
  }
}

export function accountId(code) {
  return createHash("sha256").update(`imersa:${code}`).digest("hex").slice(0, 32);
}

export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      account   TEXT NOT NULL,
      kind      TEXT NOT NULL,
      id        TEXT NOT NULL,
      seq       INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      deleted   INTEGER NOT NULL DEFAULT 0,
      json      TEXT,
      device    TEXT,
      PRIMARY KEY (account, kind, id)
    );
    CREATE INDEX IF NOT EXISTS records_pull ON records (account, seq);
    CREATE TABLE IF NOT EXISTS accounts (
      account  TEXT PRIMARY KEY,
      seq      INTEGER NOT NULL DEFAULT 0,
      created  INTEGER NOT NULL,
      lastSeen INTEGER NOT NULL,
      nrec     INTEGER NOT NULL DEFAULT 0,
      nbytes   INTEGER NOT NULL DEFAULT 0
    );
  `);
  // bancos criados antes da coluna `device` continuam abrindo normalmente
  try {
    db.exec("ALTER TABLE records ADD COLUMN device TEXT");
  } catch {
    /* a coluna já existe */
  }
  // bancos de antes da cota: cria os contadores e os preenche UMA vez a partir
  // dos registros (o ALTER só dá certo na primeira abertura)
  try {
    db.exec("ALTER TABLE accounts ADD COLUMN nrec INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE accounts ADD COLUMN nbytes INTEGER NOT NULL DEFAULT 0");
    db.exec(`UPDATE accounts SET
      nrec   = (SELECT COUNT(*) FROM records r WHERE r.account = accounts.account),
      nbytes = (SELECT COALESCE(SUM(length(CAST(r.id AS BLOB)) + COALESCE(length(CAST(r.json AS BLOB)), 0)), 0)
                FROM records r WHERE r.account = accounts.account)`);
  } catch {
    /* as colunas já existem */
  }

  const get = db.prepare(
    `SELECT seq, updatedAt, deleted, COALESCE(length(CAST(json AS BLOB)), 0) jsonBytes
     FROM records WHERE account=? AND kind=? AND id=?`);
  const put = db.prepare(
    `INSERT INTO records (account, kind, id, seq, updatedAt, deleted, json, device)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account, kind, id) DO UPDATE SET
       seq=excluded.seq, updatedAt=excluded.updatedAt,
       deleted=excluded.deleted, json=excluded.json, device=excluded.device`);
  const SELECT_COLS = "SELECT kind, id, seq, updatedAt, deleted, json FROM records";
  const pullAll = db.prepare(
    `${SELECT_COLS} WHERE account=? AND seq>? ORDER BY seq LIMIT ?`);
  // sem o eco: as linhas cuja última escrita veio deste mesmo aparelho ficam de fora
  const pullOthers = db.prepare(
    `${SELECT_COLS} WHERE account=? AND seq>? AND (device IS NULL OR device<>?)
     ORDER BY seq LIMIT ?`);
  const seqOf = db.prepare("SELECT seq FROM accounts WHERE account=?");
  const usageOf = db.prepare("SELECT nrec, nbytes FROM accounts WHERE account=?");
  const touch = db.prepare(
    `INSERT INTO accounts (account, seq, created, lastSeen) VALUES (?, 0, ?, ?)
     ON CONFLICT(account) DO UPDATE SET lastSeen=excluded.lastSeen`);
  const bump = db.prepare("UPDATE accounts SET seq=?, nrec=?, nbytes=? WHERE account=?");
  const counts = db.prepare(
    "SELECT kind, COUNT(*) n FROM records WHERE account=? AND deleted=0 GROUP BY kind");

  return {
    db,

    /** A conta já existe no servidor? (o código legado não cria conta nova) */
    exists(account) {
      return !!seqOf.get(account);
    },

    /**
     * Aplica as mudanças do cliente e devolve quantas foram aceitas. Se o lote
     * deixaria a conta acima da cota, nada é gravado e lança `QuotaError` — a
     * não ser que o lote só diminua o uso (apagar tem que funcionar sempre).
     */
    push(account, changes, device = "") {
      const now = Date.now();
      let accepted = 0;
      let seq;
      // tudo que decide (seq, uso da cota) é lido DENTRO da trava de escrita: hoje
      // o processo é um só e não há `await` aqui, mas assim continua certo se
      // outro processo gravar no mesmo banco
      db.exec("BEGIN IMMEDIATE");
      try {
        touch.run(account, now, now);
        seq = seqOf.get(account)?.seq ?? 0;
        const usage = usageOf.get(account);
        let nrec = usage.nrec;
        let nbytes = usage.nbytes;
        for (const ch of changes) {
          // item que não é objeto (null, número, texto) é ignorado — não derruba o lote
          if (!ch || typeof ch !== "object" || Array.isArray(ch)) continue;
          if (!KINDS.includes(ch.kind) || typeof ch.id !== "string" || !ch.id) continue;
          if (ch.id.length > MAX_ID_LEN) continue;
          const json = ch.deleted ? null : JSON.stringify(ch.value ?? null);
          const jsonBytes = json === null ? 0 : Buffer.byteLength(json);
          if (jsonBytes > MAX_VALUE_BYTES) continue;
          // 0, negativo, texto ou NaN → hora do servidor (um negativo perderia sempre)
          const ts = Number(ch.updatedAt);
          const updatedAt = Number.isFinite(ts) && ts > 0 ? Math.min(ts, now + MAX_SKEW_MS) : now;
          const deleted = ch.deleted ? 1 : 0;
          const prev = get.get(account, ch.kind, ch.id);
          if (prev) {
            if (EVENT_KINDS.has(ch.kind)) {
              // evento já conhecido: só um tombstone novo muda alguma coisa
              if (!deleted || prev.deleted) continue;
            } else if (updatedAt < prev.updatedAt) {
              continue; // versão local mais velha que a do servidor
            } else if (updatedAt === prev.updatedAt && (!deleted || prev.deleted)) {
              // empate: o tombstone tem preferência; tombstone repetido (retry) não
              // é novidade e não pode avançar o seq
              continue;
            }
          }
          put.run(account, ch.kind, ch.id, ++seq, updatedAt, deleted, json, device || null);
          if (prev) nbytes += jsonBytes - prev.jsonBytes;
          else { nrec++; nbytes += Buffer.byteLength(ch.id) + jsonBytes; }
          accepted++;
        }
        const over = nrec > QUOTA_RECORDS || nbytes > QUOTA_BYTES;
        if (over && (nrec > usage.nrec || nbytes > usage.nbytes)) throw new QuotaError();
        bump.run(seq, nrec, nbytes, account);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { accepted, seq };
    },

    /**
     * Registros com seq > since, em ordem, paginados. Com `device`, o que este
     * aparelho mesmo escreveu por último fica de fora — ele já tem essa versão,
     * e devolvê-la fazia o app achar que tinha chegado novidade de fora.
     *
     * O cursor do cliente (o maior `seq` recebido) simplesmente não avança sobre
     * as próprias linhas, e tudo bem: elas nunca precisam voltar. Se o outro
     * aparelho mexer numa delas, a linha ganha `device` novo e volta a aparecer.
     */
    pull(account, since, limit = PAGE, device = "") {
      const from = Number(since) || 0;
      const rows = device
        ? pullOthers.all(account, from, device, limit + 1)
        : pullAll.all(account, from, limit + 1);
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        hasMore,
        records: page.map((r) => ({
          kind: r.kind, id: r.id, seq: r.seq, updatedAt: r.updatedAt,
          deleted: !!r.deleted, value: r.json ? JSON.parse(r.json) : null,
        })),
      };
    },

    head(account) {
      return seqOf.get(account)?.seq ?? 0;
    },

    stats(account) {
      const out = { seq: this.head(account) };
      for (const row of counts.all(account)) out[row.kind] = row.n;
      return out;
    },
  };
}
