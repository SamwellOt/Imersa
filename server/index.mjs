#!/usr/bin/env node
// Servidor do Imersa: serve o app buildado + o content/ + a API de sincronização.
// Substitui o `vite preview` para que o app e o sync vivam na MESMA origem
// (sem CORS, uma porta só, um processo só).
//
//   node server/index.mjs [--port 8000] [--host 0.0.0.0]
//
// Sem dependências: usa node:http, node:sqlite e o resto da stdlib.
import { createServer } from "node:http";
import { createReadStream, statSync, existsSync, realpathSync } from "node:fs";
import { extname, join, normalize, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { accountId, openStore, PAGE } from "./sync-store.mjs";
import { openAuth, accountOfUser, AuthError, TOKEN_PREFIX } from "./auth-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = resolve(ROOT, "web/dist");
const CONTENT = resolve(ROOT, "content");
const DB_FILE = process.env.IMERSA_DB || resolve(HERE, "data/imersa.sqlite");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", process.env.PORT || 8000));
const HOST = arg("host", process.env.HOST || "0.0.0.0");
const MAX_BODY = 12 * 1024 * 1024; // 12 MB — um bundle inteiro cabe folgado
const MIN_CODE = 12;
const COI_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};
// Um worker criado por página isolada só carrega se o PRÓPRIO script dele
// também vier com COEP (senão o navegador bloqueia: ERR_BLOCKED_BY_RESPONSE).
// Nos assets do app o cabeçalho é inofensivo — só conta para script de worker.
const ASSET_HEADERS = { "cross-origin-embedder-policy": "require-corp" };

const store = openStore(DB_FILE);
const auth = openAuth(store.db);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".mp4": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function send(res, status, body, headers = {}) {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, { "content-length": buf.length, ...headers });
  res.end(buf);
}

const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8" });

/**
 * `pipe()` não repassa erros: sem estes dois handlers, um arquivo que some no
 * meio da leitura (ou um cliente que fecha a aba durante o vídeo) vira um evento
 * `error` sem ouvinte — o tipo de coisa que derruba o processo inteiro em vez de
 * abortar só aquela resposta.
 */
function pipeFile(stream, res) {
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** Serve um arquivo com suporte a Range (o player faz seek no vídeo). */
function sendFile(req, res, file, { immutable = false, headers = {} } = {}) {
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const type = MIME[extname(file).toLowerCase()] || "application/octet-stream";
  const cache = immutable
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
  const etag = `"${st.size.toString(16)}-${st.mtimeMs.toString(16)}"`;
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { etag, "cache-control": cache });
    return res.end(), true;
  }
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": cache, etag, ...headers };

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] ? Number(m[1]) : NaN;
    let end = m[2] ? Number(m[2]) : NaN;
    // sufixo (bytes=-N): os últimos N bytes. Pedir mais bytes do que o arquivo
    // tem não é erro — a RFC 7233 §2.1 manda devolver o arquivo inteiro.
    if (Number.isNaN(start)) { start = Math.max(0, st.size - end); end = st.size - 1; }
    if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
    if (!(start >= 0) || start > end) {
      return send(res, 416, "", { "content-range": `bytes */${st.size}` }), true;
    }
    res.writeHead(206, {
      ...base,
      "content-range": `bytes ${start}-${end}/${st.size}`,
      "content-length": end - start + 1,
    });
    if (req.method === "HEAD") return res.end(), true;
    pipeFile(createReadStream(file, { start, end }), res);
    return true;
  }

  res.writeHead(200, { ...base, "content-length": st.size });
  if (req.method === "HEAD") return res.end(), true;
  pipeFile(createReadStream(file), res);
  return true;
}

/** Resolve um caminho de URL dentro de uma raiz, barrando path traversal. */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // %-escape inválido: pedido malformado, não erro do servidor
  }
  if (decoded.includes("\0")) return null;
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, rel);
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const real = existsSync(file) ? realpathSync(file) : file;
  // com separador: senão `content-outro/` passaria por estar dentro de `content`
  return real === realRoot || real.startsWith(realRoot + sep) ? file : null;
}

function readBody(req) {
  return new Promise((ok, fail) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { fail(new Error("payload grande demais")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", fail);
  });
}

const bearerOf = (req) => {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
};

/**
 * Credencial → conta do sync. Duas formas:
 *   • sessão de conta (`imt_…`, ver auth-store) → o espaço da conta (`u:<id>`);
 *   • código de sincronização (legado, sem cadastro) → hash do código.
 * Sem credencial válida, não há conta.
 */
function authOf(req) {
  const cred = bearerOf(req);
  if (cred.startsWith(TOKEN_PREFIX)) {
    const s = auth.authenticate(cred);
    return s ? accountOfUser(s.user.id) : null;
  }
  if (cred.length < MIN_CODE) return null;
  return accountId(cred);
}

/** Sessão de conta obrigatória (rotas /api/auth/* que mexem na conta). */
function sessionOf(req) {
  const s = auth.authenticate(bearerOf(req));
  if (!s) throw new AuthError(401, "Sessão expirada. Entre de novo.");
  return s;
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch {
    throw new AuthError(400, "JSON inválido.");
  }
}

// `X-Forwarded-For` só vale atrás de um proxy que o reescreve (IMERSA_TRUST_PROXY=1).
// Servido direto na porta, qualquer um manda o cabeçalho que quiser — e trocar o
// "IP" a cada tentativa furava o limite de tentativas por IP do login.
const TRUST_PROXY = process.env.IMERSA_TRUST_PROXY === "1";
const clientIp = (req) =>
  String((TRUST_PROXY && req.headers["x-forwarded-for"]) || req.socket.remoteAddress || "")
    .split(",")[0].trim();

// Cabeçalhos de segurança em toda resposta: sem sniff de tipo (um .json servido
// como HTML), sem o app dentro de <iframe> de outro site (clickjacking nos
// botões de apagar conta/progresso) e sem vazar a URL em referer.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

/** Rotas de conta. Devolve `true` se tratou o pedido. */
async function handleAuth(req, res, path) {
  if (req.method !== "POST" && !(req.method === "GET" && path === "/api/auth/me")) {
    return json(res, 405, { error: "Use POST." }), true;
  }
  const meta = (body) => ({
    device: typeof body.deviceId === "string" ? body.deviceId : "",
    agent: String(req.headers["user-agent"] || ""),
  });
  switch (path) {
    case "/api/auth/register": {
      const body = await readJson(req);
      const { user, session } = await auth.register({ ...body, ...meta(body), ip: clientIp(req) });
      return json(res, 201, { ok: true, user, token: session.token, sessionId: session.id }), true;
    }
    case "/api/auth/login": {
      const body = await readJson(req);
      const { user, session } = await auth.login({ ...body, ...meta(body), ip: clientIp(req) });
      return json(res, 200, { ok: true, user, token: session.token, sessionId: session.id }), true;
    }
    case "/api/auth/logout": {
      auth.logout(bearerOf(req));
      return json(res, 200, { ok: true }), true;
    }
    case "/api/auth/me": {
      const s = sessionOf(req);
      return json(res, 200, {
        ok: true, user: s.user, sessionId: s.session.id,
        sessions: auth.sessions(s.user.id, s.session.id),
        stats: store.stats(accountOfUser(s.user.id)),
      }), true;
    }
    case "/api/auth/sessions/revoke": {
      const s = sessionOf(req);
      const body = await readJson(req);
      if (body.others) auth.revokeOthers(s.user.id, s.session.id);
      else if (typeof body.id === "string" && body.id !== s.session.id) auth.revokeSession(s.user.id, body.id);
      return json(res, 200, { ok: true, sessions: auth.sessions(s.user.id, s.session.id) }), true;
    }
    case "/api/auth/password": {
      const s = sessionOf(req);
      const body = await readJson(req);
      await auth.changePassword(s.user.id, body.current, body.next, s.session.id);
      return json(res, 200, { ok: true }), true;
    }
    case "/api/auth/profile": {
      const s = sessionOf(req);
      const body = await readJson(req);
      const user = auth.rename(s.user.id, body.name);
      return json(res, 200, { ok: true, user }), true;
    }
    case "/api/auth/delete": {
      const s = sessionOf(req);
      const body = await readJson(req);
      await auth.deleteAccount(s.user.id, body.password);
      return json(res, 200, { ok: true }), true;
    }
  }
  return false;
}

async function handleSync(req, res) {
  const account = authOf(req);
  if (!account) {
    return json(res, 401, { error: "Sessão expirada ou credencial inválida. Entre de novo em Ajustes → Conta." });
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return json(res, 400, { error: "JSON inválido." });
  }
  const changes = Array.isArray(body.changes) ? body.changes : [];
  const since = Number(body.since) || 0;
  // identifica o remetente para não devolver a ele o que ele mesmo acabou de subir
  const device = typeof body.deviceId === "string" ? body.deviceId.slice(0, 64) : "";
  let accepted = 0;
  if (changes.length) ({ accepted } = store.push(account, changes, device));
  const { records, hasMore } = store.pull(account, since, PAGE, device);
  return json(res, 200, {
    ok: true, accepted, since,
    seq: store.head(account),
    serverTime: Date.now(),
    records, hasMore, page: PAGE,
  });
}

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  try {
    if (path === "/api/health") {
      return json(res, 200, { ok: true, app: "imersa", time: Date.now() });
    }
    if (path.startsWith("/api/auth/")) {
      if (await handleAuth(req, res, path)) return;
      return json(res, 404, { error: "Rota desconhecida." });
    }
    if (path === "/api/sync") {
      if (req.method !== "POST") return json(res, 405, { error: "Use POST." });
      return await handleSync(req, res);
    }
    if (path === "/api/stats") {
      const account = authOf(req);
      if (!account) return json(res, 401, { error: "Código ausente." });
      return json(res, 200, store.stats(account));
    }
    if (path.startsWith("/api/")) return json(res, 404, { error: "Rota desconhecida." });

    if (req.method !== "GET" && req.method !== "HEAD") {
      return json(res, 405, { error: "Método não permitido." });
    }

    // /content/* vem direto da pasta content/ (não da cópia dentro do dist),
    // então trocar uma dose no disco reflete sem rebuildar o app.
    if (path.startsWith("/content/")) {
      const file = safeJoin(CONTENT, path.slice("/content".length));
      if (file && sendFile(req, res, file)) return;
      return send(res, 404, "not found", { "content-type": "text/plain" });
    }

    // /otimizar: página do otimizador do FSRS. Roda WASM com threads
    // (SharedArrayBuffer), que só existe em página "cross-origin isolated" —
    // daí os cabeçalhos COOP/COEP SÓ aqui (no app inteiro bloqueariam recurso
    // externo sem CORP). Ver web/src/optimize/main.tsx.
    if (path === "/otimizar" || path === "/otimizar.html") {
      if (sendFile(req, res, join(DIST, "otimizar.html"), { headers: COI_HEADERS })) return;
      return send(res, 503, "app não buildado — rode `npm run build` em web/",
                  { "content-type": "text/plain; charset=utf-8" });
    }

    const file = safeJoin(DIST, path === "/" ? "/index.html" : path);
    const isAsset = path.startsWith("/assets/");
    if (file && sendFile(req, res, file, { immutable: isAsset, headers: isAsset ? ASSET_HEADERS : {} })) return;

    // SPA: qualquer rota do app cai no index.html
    if (!extname(path)) {
      if (sendFile(req, res, join(DIST, "index.html"))) return;
      return send(res, 503, "app não buildado — rode `npm run build` em web/",
                  { "content-type": "text/plain; charset=utf-8" });
    }
    return send(res, 404, "not found", { "content-type": "text/plain" });
  } catch (err) {
    if (err instanceof AuthError) return json(res, err.status, { error: err.message });
    console.error("erro:", err?.message || err);
    if (!res.headersSent) return json(res, 500, { error: "Erro interno." });
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Imersa · app + sync em http://${HOST}:${PORT}`);
  console.log(`  app      ${DIST}`);
  console.log(`  content  ${CONTENT}`);
  console.log(`  banco    ${DB_FILE}`);
});
