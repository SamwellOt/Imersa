// Infra dos testes de integração do servidor (node:test, sem dependências).
//
// Cada arquivo de teste sobe o servidor DE VERDADE (`node server/index.mjs`) numa
// porta livre, com um SQLite temporário próprio (IMERSA_DB). Nada é mockado: não há
// serviço externo no servidor. O banco de produção (server/data/) nunca é usado —
// `startServer` se recusa a rodar se o caminho cair lá dentro.
//
// As requisições usam node:http (não fetch) para poder escolher o IP de origem
// (`localAddress`: 127.0.0.X). Assim os limites por IP são testados com IPs reais,
// sem ligar IMERSA_TRUST_PROXY.
import { spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, "../index.mjs");
const PROD_DATA = resolve(HERE, "../data");

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sobe um servidor novo, com banco temporário vazio. */
export async function startServer({ env: extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "imersa-test-"));
  const dbFile = join(dir, "test.sqlite");
  const real = realpathSync(dir);
  if (real === PROD_DATA || real.startsWith(PROD_DATA + sep)) {
    throw new Error(`recusado: banco de teste dentro de ${PROD_DATA}`);
  }
  const port = await freePort();
  const env = { ...process.env, ...extraEnv, IMERSA_DB: dbFile };
  delete env.IMERSA_TRUST_PROXY; // o comportamento testado é o da produção (sem proxy)
  const child = spawn(process.execPath, [SERVER, "--port", String(port), "--host", "127.0.0.1"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  const srv = { port, dbFile, dir, child, log: () => log };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`servidor saiu:\n${log}`);
    try {
      const r = await call(srv, "GET", "/api/health");
      if (r.status === 200) break;
    } catch { /* ainda subindo */ }
    await sleep(50);
  }
  srv.stop = async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    rmSync(dir, { recursive: true, force: true });
  };
  /** Conexão direta (só leitura/fixture) ao banco TEMPORÁRIO deste servidor. */
  srv.db = () => new DatabaseSync(dbFile);
  return srv;
}

/**
 * Requisição HTTP crua. `path` vai como está (sem normalizar) — necessário para
 * os testes de path traversal. Devolve { status, headers, text, body }.
 */
export function call(srv, method, path, { body, token, ip = "127.0.0.1", headers = {}, raw } = {}) {
  return new Promise((ok, fail) => {
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (payload !== undefined) {
      h["content-type"] ??= "application/json";
      h["content-length"] = Buffer.byteLength(payload);
    }
    const req = request({ host: "127.0.0.1", port: srv.port, method, path, headers: h, localAddress: ip }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(parts);
        const text = buf.toString("utf8");
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        ok({ status: res.statusCode, headers: res.headers, text, buf, body: parsed });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// IPs de loopback distintos para cada cadastro "comum": os testes que não são de
// limite de tentativas não devem esbarrar no limite por IP.
let ipSeq = 10;
export const nextIp = () => {
  ipSeq++;
  return `127.0.${Math.floor(ipSeq / 250) + 1}.${(ipSeq % 250) + 1}`;
};

let emailSeq = 0;
export const uniqueEmail = (p = "aluno") => `${p}${Date.now()}x${++emailSeq}@teste.com`;
export const PASSWORD = "senha-forte-123";

/** Cria uma conta e devolve { email, password, user, token, sessionId }. */
export async function register(srv, { email = uniqueEmail(), password = PASSWORD, name, deviceId = "dev-a" } = {}) {
  const r = await call(srv, "POST", "/api/auth/register", {
    body: { email, password, name, deviceId }, ip: nextIp(),
  });
  if (r.status !== 201) throw new Error(`cadastro falhou (${r.status}): ${r.text}`);
  return {
    email, password, user: r.body.user, token: r.body.token,
    sessionId: r.body.sessionId, deviceTrust: r.body.deviceTrust,
  };
}

export async function login(srv, email, password = PASSWORD, { deviceId = "dev-b", ip = nextIp(), deviceTrust } = {}) {
  return call(srv, "POST", "/api/auth/login", { body: { email, password, deviceId, deviceTrust }, ip });
}

export function sync(srv, token, { since = 0, deviceId, changes = [] } = {}) {
  return call(srv, "POST", "/api/sync", { token, body: { since, deviceId, changes } });
}
