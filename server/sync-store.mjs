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
      lastSeen INTEGER NOT NULL
    );
  `);
  // bancos criados antes da coluna `device` continuam abrindo normalmente
  try {
    db.exec("ALTER TABLE records ADD COLUMN device TEXT");
  } catch {
    /* a coluna já existe */
  }

  const get = db.prepare("SELECT seq, updatedAt, deleted FROM records WHERE account=? AND kind=? AND id=?");
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
  const touch = db.prepare(
    `INSERT INTO accounts (account, seq, created, lastSeen) VALUES (?, 0, ?, ?)
     ON CONFLICT(account) DO UPDATE SET lastSeen=excluded.lastSeen`);
  const bump = db.prepare("UPDATE accounts SET seq=? WHERE account=?");
  const counts = db.prepare(
    "SELECT kind, COUNT(*) n FROM records WHERE account=? AND deleted=0 GROUP BY kind");

  return {
    db,

    /** Aplica as mudanças do cliente e devolve quantas foram aceitas. */
    push(account, changes, device = "") {
      const now = Date.now();
      touch.run(account, now, now);
      let seq = seqOf.get(account)?.seq ?? 0;
      let accepted = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const ch of changes) {
          if (!KINDS.includes(ch.kind) || typeof ch.id !== "string" || !ch.id) continue;
          const updatedAt = Number(ch.updatedAt) || now;
          const deleted = ch.deleted ? 1 : 0;
          const prev = get.get(account, ch.kind, ch.id);
          if (prev) {
            if (EVENT_KINDS.has(ch.kind)) {
              // evento já conhecido: só um tombstone novo muda alguma coisa
              if (!deleted || prev.deleted) continue;
            } else if (updatedAt < prev.updatedAt) {
              continue; // versão local mais velha que a do servidor
            } else if (updatedAt === prev.updatedAt && !deleted) {
              continue; // empate: o tombstone tem preferência
            }
          }
          put.run(account, ch.kind, ch.id, ++seq, updatedAt, deleted,
                  deleted ? null : JSON.stringify(ch.value ?? null), device || null);
          accepted++;
        }
        bump.run(seq, account);
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
