// Contas do Imersa: cadastro por e-mail + senha, sessões por aparelho.
//
// Mora no MESMO SQLite do sync (node:sqlite, sem dependências). Uma conta é
// dona de um `account` do sync-store (`u:<id>`), então tudo que o aluno estuda
// logado vai para o espaço dela — e o código de sincronização antigo continua
// funcionando em paralelo, como conta anônima (ver index.mjs → authOf).
//
// Segurança, no que cabe a um app local:
//   • senha guardada com scrypt (sal por usuário, N=2^15) — nunca em claro;
//   • o token de sessão é aleatório (32 bytes) e o banco guarda só o sha256
//     dele: vazar o banco não entrega sessões vivas;
//   • login limitado por tentativas (por e-mail + por IP) para não dar para
//     adivinhar senha na força bruta;
//   • sessões expiram (180 dias sem uso) e podem ser encerradas uma a uma
//     ("Aparelhos conectados" nos Ajustes).
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

/** Prefixo do token de sessão — é assim que o `Authorization: Bearer` do sync
 *  distingue "sessão de conta" de "código de sincronização". */
export const TOKEN_PREFIX = "imt_";
export const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;
const SCRYPT_OPTS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
// limite de tentativas: 8 erros em 15 min bloqueiam por 15 min
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 8;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw) {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new AuthError(400, "Informe um e-mail válido.");
  }
  return email;
}

export function checkPassword(raw) {
  const pw = String(raw ?? "");
  if (pw.length < MIN_PASSWORD) {
    throw new AuthError(400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  }
  if (pw.length > MAX_PASSWORD) throw new AuthError(400, "Senha longa demais.");
  return pw;
}

function cleanName(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const newId = () => randomBytes(12).toString("hex");

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [algo, salt, hex] = String(stored).split("$");
  if (algo !== "scrypt" || !salt || !hex) return false;
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT_OPTS);
  const want = Buffer.from(hex, "hex");
  return key.length === want.length && timingSafeEqual(key, want);
}

/** O `account` do sync-store que pertence a esta conta. */
export const accountOfUser = (userId) => `u:${userId}`;

export function openAuth(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id        TEXT PRIMARY KEY,
      email     TEXT NOT NULL UNIQUE,
      name      TEXT NOT NULL DEFAULT '',
      passHash  TEXT NOT NULL,
      created   INTEGER NOT NULL,
      lastLogin INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id        TEXT PRIMARY KEY,
      tokenHash TEXT NOT NULL UNIQUE,
      user      TEXT NOT NULL,
      device    TEXT,
      agent     TEXT,
      created   INTEGER NOT NULL,
      lastSeen  INTEGER NOT NULL,
      expires   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user);
  `);

  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email=?"),
    userById: db.prepare("SELECT * FROM users WHERE id=?"),
    insertUser: db.prepare(
      "INSERT INTO users (id, email, name, passHash, created, lastLogin) VALUES (?, ?, ?, ?, ?, ?)"),
    touchLogin: db.prepare("UPDATE users SET lastLogin=? WHERE id=?"),
    setPass: db.prepare("UPDATE users SET passHash=? WHERE id=?"),
    setName: db.prepare("UPDATE users SET name=? WHERE id=?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id=?"),
    insertSession: db.prepare(
      `INSERT INTO sessions (id, tokenHash, user, device, agent, created, lastSeen, expires)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    sessionByToken: db.prepare("SELECT * FROM sessions WHERE tokenHash=?"),
    touchSession: db.prepare("UPDATE sessions SET lastSeen=?, expires=? WHERE id=?"),
    sessionsOfUser: db.prepare(
      "SELECT id, device, agent, created, lastSeen FROM sessions WHERE user=? AND expires>? ORDER BY lastSeen DESC"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE id=? AND user=?"),
    deleteOtherSessions: db.prepare("DELETE FROM sessions WHERE user=? AND id<>?"),
    deleteAllSessions: db.prepare("DELETE FROM sessions WHERE user=?"),
    purgeExpired: db.prepare("DELETE FROM sessions WHERE expires<=?"),
    deleteRecords: db.prepare("DELETE FROM records WHERE account=?"),
    deleteAccount: db.prepare("DELETE FROM accounts WHERE account=?"),
  };

  // ---- limite de tentativas (em memória: reiniciar o serviço zera, e tudo bem) ----
  const attempts = new Map();
  function rateCheck(key) {
    const now = Date.now();
    const a = attempts.get(key);
    if (a && a.until > now) {
      const min = Math.ceil((a.until - now) / 60000);
      throw new AuthError(429, `Muitas tentativas. Tente de novo em ${min} min.`);
    }
  }
  function rateFail(key) {
    const now = Date.now();
    const a = attempts.get(key);
    const fresh = !a || now - a.first > RATE_WINDOW_MS;
    const next = fresh ? { first: now, count: 1, until: 0 } : { ...a, count: a.count + 1 };
    if (next.count >= RATE_MAX) next.until = now + RATE_WINDOW_MS;
    attempts.set(key, next);
    if (attempts.size > 5000) {
      for (const [k, v] of attempts) if (now - v.first > RATE_WINDOW_MS && v.until < now) attempts.delete(k);
    }
  }
  const rateOk = (key) => attempts.delete(key);

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.created });

  function issueSession(userId, { device = "", agent = "" } = {}) {
    const raw = randomBytes(32).toString("base64url");
    const token = TOKEN_PREFIX + raw;
    const now = Date.now();
    const id = newId();
    q.insertSession.run(id, sha256(token), userId, device.slice(0, 64) || null,
                        agent.slice(0, 160) || null, now, now, now + SESSION_TTL_MS);
    return { id, token };
  }

  return {
    TOKEN_PREFIX,

    async register({ email, password, name, device, agent }) {
      const em = normalizeEmail(email);
      const pw = checkPassword(password);
      if (q.userByEmail.get(em)) {
        throw new AuthError(409, "Já existe uma conta com este e-mail. Quer entrar?");
      }
      const id = newId();
      const now = Date.now();
      q.insertUser.run(id, em, cleanName(name), await hashPassword(pw), now, now);
      const session = issueSession(id, { device, agent });
      return { user: publicUser(q.userById.get(id)), session };
    },

    async login({ email, password, device, agent, ip = "" }) {
      let em;
      try {
        em = normalizeEmail(email);
      } catch {
        throw new AuthError(401, "E-mail ou senha incorretos.");
      }
      const keys = [`e:${em}`, `ip:${ip}`];
      for (const k of keys) rateCheck(k);
      const user = q.userByEmail.get(em);
      const ok = user && (await verifyPassword(String(password ?? ""), user.passHash));
      if (!ok) {
        for (const k of keys) rateFail(k);
        throw new AuthError(401, "E-mail ou senha incorretos.");
      }
      for (const k of keys) rateOk(k);
      q.touchLogin.run(Date.now(), user.id);
      const session = issueSession(user.id, { device, agent });
      return { user: publicUser(user), session };
    },

    /**
     * Token → { user, session } ou null. Renova o prazo a cada uso (sessão
     * "deslizante": quem estuda continua logado; quem some por 180 dias sai).
     */
    authenticate(token) {
      if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return null;
      const s = q.sessionByToken.get(sha256(token));
      const now = Date.now();
      if (!s || s.expires <= now) return null;
      const user = q.userById.get(s.user);
      if (!user) return null;
      // grava no máximo uma vez por minuto: o sync bate a cada 5 min e a cada nota
      if (now - s.lastSeen > 60_000) q.touchSession.run(now, now + SESSION_TTL_MS, s.id);
      return { user: publicUser(user), session: { id: s.id, device: s.device } };
    },

    logout(token) {
      if (typeof token !== "string") return;
      const s = q.sessionByToken.get(sha256(token));
      if (s) q.deleteSession.run(s.id, s.user);
    },

    sessions(userId, currentId) {
      q.purgeExpired.run(Date.now());
      return q.sessionsOfUser.all(userId, Date.now()).map((s) => ({
        id: s.id,
        device: s.device,
        agent: s.agent,
        createdAt: s.created,
        lastSeenAt: s.lastSeen,
        current: s.id === currentId,
      }));
    },

    revokeSession(userId, sessionId) {
      q.deleteSession.run(String(sessionId), userId);
    },

    revokeOthers(userId, currentId) {
      q.deleteOtherSessions.run(userId, currentId);
    },

    async changePassword(userId, current, next, currentSessionId) {
      const user = q.userById.get(userId);
      if (!user) throw new AuthError(401, "Sessão inválida.");
      if (!(await verifyPassword(String(current ?? ""), user.passHash))) {
        throw new AuthError(403, "A senha atual não confere.");
      }
      const pw = checkPassword(next);
      q.setPass.run(await hashPassword(pw), userId);
      // trocar a senha derruba os OUTROS aparelhos — é para isso que se troca
      q.deleteOtherSessions.run(userId, currentSessionId);
    },

    rename(userId, name) {
      q.setName.run(cleanName(name), userId);
      return publicUser(q.userById.get(userId));
    },

    /** Apaga a conta, as sessões e TODO o progresso dela no servidor. */
    async deleteAccount(userId, password) {
      const user = q.userById.get(userId);
      if (!user) throw new AuthError(401, "Sessão inválida.");
      if (!(await verifyPassword(String(password ?? ""), user.passHash))) {
        throw new AuthError(403, "A senha não confere.");
      }
      const account = accountOfUser(userId);
      db.exec("BEGIN IMMEDIATE");
      try {
        q.deleteAllSessions.run(userId);
        q.deleteRecords.run(account);
        q.deleteAccount.run(account);
        q.deleteUser.run(userId);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
