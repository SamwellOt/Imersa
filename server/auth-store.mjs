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

/** Prefixo da marca de "aparelho confiável" (ver `trustOf`). */
export const TRUST_PREFIX = "imd_";
export const TRUST_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// Disjuntor de cadastros: teto GLOBAL de contas novas por hora. Não é limite de
// ninguém em particular — só impede que um laço encha o banco.
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const SIGNUP_MAX = Number(process.env.IMERSA_SIGNUP_MAX_PER_HOUR) || 100;
// Disjuntor de "e-mail já cadastrado": o cadastro responde diferente para e-mail
// novo (201) e existente (409) — sem confirmação por e-mail, isso não tem como
// sumir. O limite por IP freia um atacante; este teto GLOBAL freia o que vem
// espalhado por muitos IPs. Passou dele, TODO cadastro espera (bloquear só os
// repetidos responderia 429 justamente para os e-mails que existem).
const REGDUP_MAX = Number(process.env.IMERSA_REGDUP_MAX_PER_HOUR) || 20;

export class AuthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- fila do scrypt ----
// Cada scrypt usa ~32 MB e dezenas de ms de CPU. Sem teto, uma rajada de
// cadastros/logins válidos esgotava a memória do processo. Em vez de barrar
// alguém, os pedidos fazem fila: no máximo KDF_MAX rodando, e só uma fila
// absurda (KDF_QUEUE_MAX) é recusada com 503.
const KDF_MAX = Number(process.env.IMERSA_KDF_MAX) || 4;
const KDF_QUEUE_MAX = 256;
const kdf = { running: 0, peak: 0, queue: [] };

async function withKdf(fn) {
  if (kdf.running < KDF_MAX) kdf.running++;
  else {
    if (kdf.queue.length >= KDF_QUEUE_MAX) {
      throw new AuthError(503, "Servidor ocupado. Tente de novo em instantes.");
    }
    await new Promise((r) => kdf.queue.push(r)); // a vaga chega já reservada
  }
  kdf.peak = Math.max(kdf.peak, kdf.running);
  try {
    return await fn();
  } finally {
    const next = kdf.queue.shift();
    if (next) next(); // passa a vaga adiante sem liberar (ninguém fura a fila)
    else kdf.running--;
  }
}

/** Para os testes: quantos scrypts rodaram juntos no máximo. */
export const kdfStats = () => ({ running: kdf.running, peak: kdf.peak, queued: kdf.queue.length, max: KDF_MAX });

// hash de uma senha qualquer, só para o login de e-mail inexistente custar o mesmo
const DUMMY_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(KEY_LEN * 2)}`;

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
  const key = await withKdf(() => scrypt(password, salt, KEY_LEN, SCRYPT_OPTS));
  return `scrypt$${salt}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [algo, salt, hex] = String(stored).split("$");
  if (algo !== "scrypt" || !salt || !hex) return false;
  const key = await withKdf(() => scrypt(password, salt, KEY_LEN, SCRYPT_OPTS));
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
    -- "aparelho confiável": marca entregue a quem já acertou a senha neste
    -- aparelho. Sobrevive ao logout; o banco guarda só o sha256 dela.
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id        TEXT PRIMARY KEY,
      tokenHash TEXT NOT NULL UNIQUE,
      user      TEXT NOT NULL,
      created   INTEGER NOT NULL,
      lastUsed  INTEGER NOT NULL,
      expires   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trusted_user ON trusted_devices (user);
  `);
  // bancos de antes da marca: a sessão passa a lembrar de qual aparelho confiável nasceu
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN trust TEXT");
  } catch {
    /* a coluna já existe */
  }

  const q = {
    userByEmail: db.prepare("SELECT * FROM users WHERE email=?"),
    userById: db.prepare("SELECT * FROM users WHERE id=?"),
    insertUser: db.prepare(
      "INSERT INTO users (id, email, name, passHash, created, lastLogin) VALUES (?, ?, ?, ?, ?, ?)"),
    touchLogin: db.prepare("UPDATE users SET lastLogin=? WHERE id=?"),
    // troca condicional: só grava se o hash ainda é o que foi conferido (ver changePassword)
    setPassIf: db.prepare("UPDATE users SET passHash=? WHERE id=? AND passHash=?"),
    sessionAlive: db.prepare("SELECT 1 FROM sessions WHERE id=? AND user=? AND expires>?"),
    setName: db.prepare("UPDATE users SET name=? WHERE id=?"),
    deleteUser: db.prepare("DELETE FROM users WHERE id=?"),
    insertSession: db.prepare(
      `INSERT INTO sessions (id, tokenHash, user, device, agent, created, lastSeen, expires, trust)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    trustByToken: db.prepare("SELECT * FROM trusted_devices WHERE tokenHash=?"),
    insertTrust: db.prepare(
      "INSERT INTO trusted_devices (id, tokenHash, user, created, lastUsed, expires) VALUES (?, ?, ?, ?, ?, ?)"),
    touchTrust: db.prepare("UPDATE trusted_devices SET lastUsed=?, expires=? WHERE id=?"),
    // `IS NOT`: sessão sem marca (NULL) não protege marca nenhuma
    deleteOtherTrusts: db.prepare(
      "DELETE FROM trusted_devices WHERE user=? AND id IS NOT (SELECT trust FROM sessions WHERE id=?)"),
    deleteTrustOfSession: db.prepare(
      "DELETE FROM trusted_devices WHERE user=? AND id=(SELECT trust FROM sessions WHERE id=? AND user=?)"),
    deleteAllTrusts: db.prepare("DELETE FROM trusted_devices WHERE user=?"),
    purgeExpiredTrusts: db.prepare("DELETE FROM trusted_devices WHERE expires<=?"),
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
  // desfaz UMA tentativa reservada (login certo): não zera a janela inteira
  function rateUndo(key) {
    const a = attempts.get(key);
    if (!a) return;
    if (a.count <= 1) return void attempts.delete(key);
    const count = a.count - 1;
    attempts.set(key, { ...a, count, until: count >= RATE_MAX ? a.until : 0 });
  }

  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.created });

  /**
   * Conferir-e-gravar numa transação só (`BEGIN IMMEDIATE` = trava de escrita do
   * SQLite, o equivalente do `SELECT … FOR UPDATE`). Depois de um `await` (o
   * scrypt), o que foi lido antes pode ter mudado: a senha, a sessão, a conta.
   * `fn` é síncrona — nada de `await` dentro.
   */
  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  /** A sessão que fez o pedido ainda existe? (pode ter sido encerrada durante o scrypt) */
  function requireSession(userId, sessionId) {
    if (!q.userById.get(userId) || !q.sessionAlive.get(String(sessionId), userId, Date.now())) {
      throw new AuthError(401, "Sessão expirada. Entre de novo.");
    }
  }

  const PASSWORD_RACE_MSG = "A senha da conta mudou durante este pedido. Entre de novo com a senha atual.";

  /** A marca de aparelho confiável vale para ESTA conta? → linha ou null. */
  function trustOf(token, userId) {
    if (typeof token !== "string" || !token.startsWith(TRUST_PREFIX) || token.length > 100) return null;
    const t = q.trustByToken.get(sha256(token));
    return t && t.user === userId && t.expires > Date.now() ? t : null;
  }

  /** Mantém (renova) a marca que o aparelho já tem, ou entrega uma nova. */
  function ensureTrust(userId, token) {
    const now = Date.now();
    const t = trustOf(token, userId);
    if (t) {
      q.touchTrust.run(now, now + TRUST_TTL_MS, t.id);
      return { id: t.id, token };
    }
    const fresh = TRUST_PREFIX + randomBytes(32).toString("base64url");
    const id = newId();
    q.insertTrust.run(id, sha256(fresh), userId, now, now, now + TRUST_TTL_MS);
    return { id, token: fresh };
  }

  function issueSession(userId, { device = "", agent = "", deviceTrust } = {}) {
    const raw = randomBytes(32).toString("base64url");
    const token = TOKEN_PREFIX + raw;
    const now = Date.now();
    const id = newId();
    const trust = ensureTrust(userId, deviceTrust);
    q.insertSession.run(id, sha256(token), userId, String(device).slice(0, 64) || null,
                        String(agent).slice(0, 160) || null, now, now, now + SESSION_TTL_MS, trust.id);
    return { id, token, deviceTrust: trust.token };
  }

  // disjuntor: horários dos cadastros (aceitos ou em andamento) da última hora
  const signups = [];
  function signupReserve() {
    const now = Date.now();
    while (signups.length && now - signups[0] > SIGNUP_WINDOW_MS) signups.shift();
    if (signups.length >= SIGNUP_MAX) {
      throw new AuthError(429, "Muitas contas novas agora. Tente de novo mais tarde.");
    }
    signups.push(now);
    return now;
  }
  function signupRelease(stamp) {
    const i = signups.indexOf(stamp);
    if (i >= 0) signups.splice(i, 1);
  }

  // horários das respostas "e-mail já cadastrado" da última hora (todo o servidor)
  const regDups = [];
  function regDupCheck() {
    const now = Date.now();
    while (regDups.length && now - regDups[0] > SIGNUP_WINDOW_MS) regDups.shift();
    if (regDups.length >= REGDUP_MAX) {
      throw new AuthError(429, "Muitas tentativas de cadastro agora. Tente de novo mais tarde.");
    }
  }
  function duplicateEmail(key) {
    rateFail(key);
    regDups.push(Date.now());
    return new AuthError(409, "Já existe uma conta com este e-mail. Quer entrar?");
  }

  /**
   * Confere a senha da conta antes de trocar a senha ou apagar a conta. Limitada
   * como o login (8 erros em 15 min): sem isso, um token roubado chutava a senha
   * à vontade — e acertando, trocava a senha e trancava o dono fora.
   * Devolve o hash conferido: a gravação seguinte só vale se ele não mudou.
   */
  async function confirmPassword(user, password, message) {
    const key = `pw:${user.id}`;
    rateCheck(key);
    rateFail(key); // reserva antes do scrypt, como no login (rajada concorrente)
    let ok;
    try {
      ok = await verifyPassword(String(password ?? ""), user.passHash);
    } catch (err) {
      rateUndo(key); // servidor ocupado não é erro de quem tenta
      throw err;
    }
    if (!ok) throw new AuthError(403, message);
    rateUndo(key);
    return user.passHash;
  }

  return {
    TOKEN_PREFIX,

    async register({ email, password, name, device, agent, ip = "" }) {
      // cadastro é limitado por IP, mas só as tentativas que FALHAM contam
      // (e-mail inválido, senha fraca, e-mail já usado): cadastro bem-sucedido
      // não consome o limite (decisão do usuário, 31/10/2026).
      const key = `reg:${ip}`;
      rateCheck(key);
      regDupCheck();
      let em, pw;
      try {
        em = normalizeEmail(email);
        pw = checkPassword(password);
      } catch (err) {
        rateFail(key);
        throw err;
      }
      if (q.userByEmail.get(em)) throw duplicateEmail(key);
      // reserva a vaga no disjuntor ANTES do scrypt: senão uma rajada simultânea
      // passaria inteira enquanto as outras ainda estão no await
      const stamp = signupReserve();
      const id = newId();
      const now = Date.now();
      try {
        const passHash = await hashPassword(pw);
        q.insertUser.run(id, em, cleanName(name), passHash, now, now);
      } catch (err) {
        signupRelease(stamp);
        // dois cadastros do mesmo e-mail ao mesmo tempo (duplo toque): ambos
        // passam da checagem acima durante o scrypt e o segundo bate no UNIQUE
        if (!(err instanceof AuthError) && q.userByEmail.get(em)) throw duplicateEmail(key);
        throw err;
      }
      // quem cria a conta neste aparelho já sai com ele marcado como confiável
      const session = issueSession(id, { device, agent });
      return { user: publicUser(q.userById.get(id)), session };
    },

    /**
     * Três limites, cada um de QUEM tenta — nenhum tranca o dono fora:
     *   • por IP (`ip:`): um IP que erra 8 vezes espera 15 min;
     *   • por conta, só para aparelhos SEM marca (`a:`): um ataque espalhado por
     *     muitos IPs esbarra nas 8 tentativas da conta;
     *   • por aparelho confiável (`t:`): o dono, com a marca, passa por cima do
     *     bloqueio da conta e só conta os próprios erros (uma marca roubada sem a
     *     senha também não chuta à vontade).
     */
    async login({ email, password, device, agent, ip = "", deviceTrust }) {
      let em;
      try {
        em = normalizeEmail(email);
      } catch {
        throw new AuthError(401, "E-mail ou senha incorretos.");
      }
      const user = q.userByEmail.get(em);
      const trust = user ? trustOf(deviceTrust, user.id) : null;
      const keys = [`ip:${ip}`, trust ? `t:${trust.id}` : `a:${em}`];
      for (const k of keys) rateCheck(k);
      // reserva a tentativa ANTES do scrypt: senão uma rajada concorrente de senhas
      // erradas passa inteira enquanto as outras ainda estão no await
      for (const k of keys) rateFail(k);
      let ok;
      try {
        // e-mail sem conta também paga um scrypt: senão a resposta instantânea
        // entregava quais e-mails têm conta (tempo de resposta ≠)
        ok = user
          ? await verifyPassword(String(password ?? ""), user.passHash)
          : (await verifyPassword(String(password ?? ""), DUMMY_HASH), false);
      } catch (err) {
        for (const k of keys) rateUndo(k); // servidor ocupado não é erro de quem tenta
        throw err;
      }
      if (!ok) throw new AuthError(401, "E-mail ou senha incorretos.");
      // sucesso: IP e marca só desfazem a própria reserva — zerar o do IP deixaria
      // um atacante com conta própria resetar o limite. Acertar a senha de um
      // aparelho sem marca zera o contador da conta; com marca, o bloqueio da
      // conta continua valendo para os estranhos.
      rateUndo(keys[0]);
      if (trust) rateUndo(keys[1]);
      else attempts.delete(keys[1]);
      // a senha conferida foi a lida ANTES do scrypt: se ela mudou (ou a conta
      // sumiu) nesse meio tempo, esta sessão escaparia do "trocar a senha
      // derruba os outros aparelhos" — então não nasce
      const session = tx(() => {
        const cur = q.userById.get(user.id);
        if (!cur || cur.passHash !== user.passHash) throw new AuthError(401, "E-mail ou senha incorretos.");
        q.touchLogin.run(Date.now(), user.id);
        return issueSession(user.id, { device, agent, deviceTrust });
      });
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
      q.purgeExpiredTrusts.run(Date.now());
      return q.sessionsOfUser.all(userId, Date.now()).map((s) => ({
        id: s.id,
        device: s.device,
        agent: s.agent,
        createdAt: s.created,
        lastSeenAt: s.lastSeen,
        current: s.id === currentId,
      }));
    },

    // Encerrar um aparelho nos Ajustes também retira a confiança dele: senão um
    // aparelho perdido/roubado continuava passando por cima do bloqueio da conta.
    revokeSession(userId, sessionId) {
      q.deleteTrustOfSession.run(userId, String(sessionId), userId);
      q.deleteSession.run(String(sessionId), userId);
    },

    revokeOthers(userId, currentId) {
      q.deleteOtherTrusts.run(userId, currentId);
      q.deleteOtherSessions.run(userId, currentId);
    },

    async changePassword(userId, current, next, currentSessionId) {
      const user = q.userById.get(userId);
      if (!user) throw new AuthError(401, "Sessão inválida.");
      const verified = await confirmPassword(user, current, "A senha atual não confere.");
      const pw = checkPassword(next);
      const passHash = await hashPassword(pw);
      tx(() => {
        // durante os dois scrypts a sessão pode ter sido encerrada, e outro
        // pedido pode ter trocado a senha: gravação condicional ao hash conferido
        // (duas trocas ao mesmo tempo → uma 200, a outra 409, nenhuma mente)
        requireSession(userId, currentSessionId);
        if (q.setPassIf.run(passHash, userId, verified).changes !== 1) {
          throw new AuthError(409, PASSWORD_RACE_MSG);
        }
        // trocar a senha derruba os OUTROS aparelhos — é para isso que se troca —
        // e tira a confiança deles (fica só a deste aparelho)
        q.deleteOtherTrusts.run(userId, currentSessionId);
        q.deleteOtherSessions.run(userId, currentSessionId);
      });
    },

    rename(userId, name) {
      q.setName.run(cleanName(name), userId);
      return publicUser(q.userById.get(userId));
    },

    /** Apaga a conta, as sessões e TODO o progresso dela no servidor. */
    async deleteAccount(userId, password, currentSessionId) {
      const user = q.userById.get(userId);
      if (!user) throw new AuthError(401, "Sessão inválida.");
      const verified = await confirmPassword(user, password, "A senha não confere.");
      const account = accountOfUser(userId);
      tx(() => {
        // depois do scrypt: dois "apagar" ao mesmo tempo (o segundo acha a conta
        // já apagada → 401), a sessão encerrada nesse meio tempo (→ 401) e a
        // senha trocada por outro pedido (a conferida não vale mais → 409)
        requireSession(userId, currentSessionId);
        if (q.userById.get(userId).passHash !== verified) throw new AuthError(409, PASSWORD_RACE_MSG);
        q.deleteAllSessions.run(userId);
        q.deleteAllTrusts.run(userId);
        q.deleteRecords.run(account);
        q.deleteAccount.run(account);
        q.deleteUser.run(userId);
      });
    },
  };
}
