// A. Cadastro · B. Login, sessão e logout
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, call, register, login, uniqueEmail, nextIp, PASSWORD } from "./helpers.mjs";

describe("A. Cadastro — POST /api/auth/register", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("A1 quando mando e-mail válido e senha de 8+, então 201 com user, token imt_ e sessionId, e o token já vale em /me", async () => {
    const email = uniqueEmail();
    const r = await call(srv, "POST", "/api/auth/register", {
      body: { email, password: PASSWORD, name: "Ana", deviceId: "d1" }, ip: nextIp(),
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, email);
    assert.match(r.body.token, /^imt_/);
    assert.equal(typeof r.body.sessionId, "string");
    assert.equal(r.body.user.passHash, undefined, "hash da senha não pode vazar");
    const me = await call(srv, "GET", "/api/auth/me", { token: r.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, r.body.user.id);
  });

  it("A2 quando o e-mail vem com maiúsculas/espaços, então é salvo normalizado e o login com outra caixa funciona", async () => {
    const base = uniqueEmail("caixa");
    const acc = await register(srv, { email: `  ${base.toUpperCase()}  ` });
    assert.equal(acc.user.email, base.toLowerCase());
    const r = await login(srv, base.replace(/^c/, "C"));
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, acc.user.id);
  });

  it("A3 quando o e-mail é inválido, então 400 \"Informe um e-mail válido.\"", async () => {
    for (const email of ["", "sem-arroba", "a@b", "a b@c.com", null]) {
      const r = await call(srv, "POST", "/api/auth/register", { body: { email, password: PASSWORD }, ip: nextIp() });
      assert.equal(r.status, 400, `e-mail ${JSON.stringify(email)}`);
      assert.equal(r.body.error, "Informe um e-mail válido.");
    }
  });

  it("A4 quando a senha tem 7 caracteres → 400; exatamente 8 → 201; 201 caracteres → 400", async () => {
    const r7 = await call(srv, "POST", "/api/auth/register", { body: { email: uniqueEmail(), password: "1234567" }, ip: nextIp() });
    assert.equal(r7.status, 400);
    const r8 = await call(srv, "POST", "/api/auth/register", { body: { email: uniqueEmail(), password: "12345678" }, ip: nextIp() });
    assert.equal(r8.status, 201);
    const rLong = await call(srv, "POST", "/api/auth/register", { body: { email: uniqueEmail(), password: "x".repeat(201) }, ip: nextIp() });
    assert.equal(rLong.status, 400);
    assert.equal(rLong.body.error, "Senha longa demais.");
  });

  it("A5 quando o e-mail já tem conta, então 409 e a conta existente continua com a senha antiga", async () => {
    const acc = await register(srv);
    const r = await call(srv, "POST", "/api/auth/register", { body: { email: acc.email, password: "outra-senha-999" }, ip: nextIp() });
    assert.equal(r.status, 409);
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 200);
    assert.equal((await login(srv, acc.email, "outra-senha-999")).status, 401);
  });

  it("A6 quando chegam 2 cadastros do mesmo e-mail ao mesmo tempo, então um 201, outro 409 e só 1 usuário no banco", async () => {
    const email = uniqueEmail("duplo");
    const ip = nextIp();
    const rs = await Promise.all([1, 2].map(() =>
      call(srv, "POST", "/api/auth/register", { body: { email, password: PASSWORD }, ip })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
    const db = srv.db();
    try {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email=?").get(email).n, 1);
    } finally { db.close(); }
  });

  it("A7a quando o mesmo IP faz 10 cadastros bem-sucedidos em 15 min, então todos dão 201 (sucesso não conta para o limite)", async () => {
    const ip = "127.0.200.1";
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const r = await call(srv, "POST", "/api/auth/register", { body: { email: uniqueEmail("lote"), password: PASSWORD }, ip });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, Array(10).fill(201));
  });

  it("A7b quando o mesmo IP acumula 8 cadastros que falharam, então a 9ª tentativa dá 429", async () => {
    const ip = "127.0.200.2";
    for (let i = 0; i < 8; i++) {
      const r = await call(srv, "POST", "/api/auth/register", { body: { email: "invalido", password: PASSWORD }, ip });
      assert.equal(r.status, 400);
    }
    const r = await call(srv, "POST", "/api/auth/register", { body: { email: uniqueEmail(), password: PASSWORD }, ip });
    assert.equal(r.status, 429);
  });

  it("A8 quando o corpo não é JSON, ou é array/null, então 400 \"JSON inválido.\" (não 500)", async () => {
    for (const raw of ["{nao json", "[1,2]", "null", "42"]) {
      const r = await call(srv, "POST", "/api/auth/register", { raw, ip: nextIp() });
      assert.equal(r.status, 400, `corpo ${raw}`);
      assert.equal(r.body.error, "JSON inválido.");
    }
  });

  it("A9 quando faço GET em vez de POST, então 405", async () => {
    assert.equal((await call(srv, "GET", "/api/auth/register")).status, 405);
    assert.equal((await call(srv, "GET", "/api/auth/login")).status, 405);
  });
});

describe("B. Login, sessão e logout", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("B1 quando a senha está certa, então 200 com token novo, e cada login é uma sessão separada", async () => {
    const acc = await register(srv);
    const r1 = await login(srv, acc.email);
    const r2 = await login(srv, acc.email);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.notEqual(r1.body.token, acc.token);
    assert.notEqual(r1.body.token, r2.body.token);
    const me = await call(srv, "GET", "/api/auth/me", { token: r1.body.token });
    assert.equal(me.body.sessions.length, 3);
  });

  it("B2 quando a senha está errada ou o e-mail não existe, então 401 com a MESMA mensagem", async () => {
    const acc = await register(srv);
    const wrong = await login(srv, acc.email, "senha-errada-1");
    const ghost = await login(srv, uniqueEmail("fantasma"), "senha-errada-1");
    const bad = await login(srv, "nem-email", "senha-errada-1");
    for (const r of [wrong, ghost, bad]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "E-mail ou senha incorretos.");
    }
  });

  it("B3a quando um IP erra 8 vezes a senha de uma conta, então a 9ª tentativa DESSE IP dá 429", async () => {
    const acc = await register(srv);
    const ip = "127.0.201.1";
    for (let i = 0; i < 8; i++) assert.equal((await login(srv, acc.email, "errada-xxx", { ip })).status, 401);
    assert.equal((await login(srv, acc.email, PASSWORD, { ip })).status, 429);
  });

  // regra revista em 31/10/2026 (F2/F3): "o dono" = o aparelho dele, com a marca de confiança
  it("B3b quando um estranho erra 8+ vezes a senha da minha conta, então EU, do meu aparelho (com a marca), de outro IP e com a senha certa, entro", async () => {
    const acc = await register(srv);
    const attacker = "127.0.201.2";
    for (let i = 0; i < 9; i++) await login(srv, acc.email, "chute-errado", { ip: attacker });
    const owner = await login(srv, acc.email, PASSWORD, { ip: "127.0.201.3", deviceTrust: acc.deviceTrust });
    assert.equal(owner.status, 200, `dono bloqueado: ${owner.text}`);
  });

  it("B4 quando acerto o login depois de alguns erros (< 8), então o contador do e-mail zera (5 erros + acerto + 5 erros, de IPs variados, sem 429)", async () => {
    const acc = await register(srv);
    for (let i = 0; i < 5; i++) assert.equal((await login(srv, acc.email, "errada-xxx")).status, 401);
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await login(srv, acc.email, "errada-xxx")).status, 401);
  });

  it("B5 quando mando 10 logins errados ao mesmo tempo, então no máximo 8 voltam 401 e o resto 429", async () => {
    const acc = await register(srv);
    const ip = "127.0.201.5";
    const rs = await Promise.all(Array.from({ length: 10 }, () => login(srv, acc.email, "errada-xxx", { ip })));
    const n401 = rs.filter((r) => r.status === 401).length;
    const n429 = rs.filter((r) => r.status === 429).length;
    assert.equal(n401 + n429, 10);
    assert.ok(n401 <= 8, `${n401} tentativas passaram`);
  });

  it("B6 quando troco o X-Forwarded-For a cada tentativa (sem IMERSA_TRUST_PROXY), então o limite por IP continua valendo", async () => {
    const ip = "127.0.201.6";
    const statuses = [];
    for (let i = 0; i < 9; i++) {
      const r = await call(srv, "POST", "/api/auth/login", {
        body: { email: uniqueEmail("xff"), password: "errada-xxx" }, ip,
        headers: { "x-forwarded-for": `10.9.${i}.${i + 1}` },
      });
      statuses.push(r.status);
    }
    assert.equal(statuses.at(-1), 429, `statuses: ${statuses}`);
  });

  it("B7 quando chamo /me sem token, com token inventado ou com sessão expirada, então 401", async () => {
    assert.equal((await call(srv, "GET", "/api/auth/me")).status, 401);
    assert.equal((await call(srv, "GET", "/api/auth/me", { token: "imt_inventado" })).status, 401);
    const acc = await register(srv);
    const db = srv.db();
    try {
      db.prepare("UPDATE sessions SET expires=?, lastSeen=? WHERE id=?").run(Date.now() - 1000, Date.now() - 181 * 864e5, acc.sessionId);
    } finally { db.close(); }
    assert.equal((await call(srv, "GET", "/api/auth/me", { token: acc.token })).status, 401);
  });

  it("B8 quando faço logout, então aquele token dá 401 e as outras sessões da conta continuam", async () => {
    const acc = await register(srv);
    const other = (await login(srv, acc.email)).body.token;
    assert.equal((await call(srv, "POST", "/api/auth/logout", { token: acc.token })).status, 200);
    assert.equal((await call(srv, "GET", "/api/auth/me", { token: acc.token })).status, 401);
    assert.equal((await call(srv, "GET", "/api/auth/me", { token: other })).status, 200);
  });

  it("B9 quando faço logout duas vezes ou sem token, então 200 em todas e nada quebra", async () => {
    const acc = await register(srv);
    assert.equal((await call(srv, "POST", "/api/auth/logout", { token: acc.token })).status, 200);
    assert.equal((await call(srv, "POST", "/api/auth/logout", { token: acc.token })).status, 200);
    assert.equal((await call(srv, "POST", "/api/auth/logout")).status, 200);
    assert.equal((await call(srv, "GET", "/api/health")).status, 200);
  });
});
