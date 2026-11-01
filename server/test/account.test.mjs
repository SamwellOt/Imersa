// C. Gestão da conta: sessões, senha, nome, exclusão
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, call, register, login, sync, PASSWORD } from "./helpers.mjs";

const me = (srv, token) => call(srv, "GET", "/api/auth/me", { token });
const revoke = (srv, token, body) => call(srv, "POST", "/api/auth/sessions/revoke", { token, body });

describe("C. Gestão da conta", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("C1 quando encerro outra sessão minha pelo id, então ela dá 401 e some da lista", async () => {
    const acc = await register(srv);
    const b = (await login(srv, acc.email)).body;
    const r = await revoke(srv, acc.token, { id: b.sessionId });
    assert.equal(r.status, 200);
    assert.ok(!r.body.sessions.some((s) => s.id === b.sessionId));
    assert.equal((await me(srv, b.token)).status, 401);
    assert.equal((await me(srv, acc.token)).status, 200);
  });

  it("C2 quando peço {others: true}, então todas as outras caem e a atual continua", async () => {
    const acc = await register(srv);
    const b = (await login(srv, acc.email)).body.token;
    const c = (await login(srv, acc.email)).body.token;
    const r = await revoke(srv, acc.token, { others: true });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.sessions.map((s) => s.id), [acc.sessionId]);
    assert.equal((await me(srv, b)).status, 401);
    assert.equal((await me(srv, c)).status, 401);
    assert.equal((await me(srv, acc.token)).status, 200);
  });

  it("C3 quando tento encerrar a minha própria sessão atual por id, então nada acontece (200, continuo logado)", async () => {
    const acc = await register(srv);
    assert.equal((await revoke(srv, acc.token, { id: acc.sessionId })).status, 200);
    assert.equal((await me(srv, acc.token)).status, 200);
  });

  it("C4 quando troco a senha com a atual certa, então a nova entra, a antiga não serve, os outros aparelhos caem e o atual fica", async () => {
    const acc = await register(srv);
    const other = (await login(srv, acc.email)).body.token;
    const r = await call(srv, "POST", "/api/auth/password", { token: acc.token, body: { current: PASSWORD, next: "nova-senha-456" } });
    assert.equal(r.status, 200);
    assert.equal((await me(srv, acc.token)).status, 200);
    assert.equal((await me(srv, other)).status, 401);
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 401);
    assert.equal((await login(srv, acc.email, "nova-senha-456")).status, 200);
  });

  it("C5 quando a senha atual está errada → 403 e nada muda; quando a nova é curta → 400 e a antiga continua", async () => {
    const acc = await register(srv);
    const other = (await login(srv, acc.email)).body.token;
    const wrong = await call(srv, "POST", "/api/auth/password", { token: acc.token, body: { current: "errada-123", next: "nova-senha-456" } });
    assert.equal(wrong.status, 403);
    const short = await call(srv, "POST", "/api/auth/password", { token: acc.token, body: { current: PASSWORD, next: "curta" } });
    assert.equal(short.status, 400);
    assert.equal((await me(srv, other)).status, 200, "outro aparelho não pode cair numa troca que falhou");
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 200);
    assert.equal((await login(srv, acc.email, "nova-senha-456")).status, 401);
  });

  // Revisto em 31/10/2026 (auditoria de condições de corrida, decisão do usuário):
  // antes as duas respondiam 200 e uma delas mentia — a senha "trocada" não valia.
  it("C6 quando mando 2 trocas de senha ao mesmo tempo com novas diferentes, então uma dá 200, a outra 409 e só a nova da que deu 200 vale", async () => {
    const acc = await register(srv);
    const news = ["nova-um-1111", "nova-dois-2222"];
    const rs = await Promise.all(news.map((next) =>
      call(srv, "POST", "/api/auth/password", { token: acc.token, body: { current: PASSWORD, next } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const won = news[rs.findIndex((r) => r.status === 200)];
    const lost = news[rs.findIndex((r) => r.status === 409)];
    assert.equal((await login(srv, acc.email, won)).status, 200);
    assert.equal((await login(srv, acc.email, lost)).status, 401);
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 401);
  });

  it("C7 quando renomeio com espaços sobrando ou com mais de 60 caracteres, então o nome é limpo e cortado em 60", async () => {
    const acc = await register(srv);
    const r = await call(srv, "POST", "/api/auth/profile", { token: acc.token, body: { name: "   Ana    Maria  " } });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.name, "Ana Maria");
    const long = await call(srv, "POST", "/api/auth/profile", { token: acc.token, body: { name: "x".repeat(100) } });
    assert.equal(long.body.user.name.length, 60);
  });

  it("C8 quando apago a conta com a senha certa, então todos os tokens dão 401, o progresso some e um cadastro novo com o mesmo e-mail começa vazio", async () => {
    const acc = await register(srv);
    const other = (await login(srv, acc.email)).body.token;
    await sync(srv, acc.token, { deviceId: "d1", changes: [
      { kind: "card", id: "ko-A1-01::w-있다", updatedAt: Date.now(), value: { x: 1 } },
      { kind: "review", id: "rev-1", updatedAt: Date.now(), value: { g: 3 } },
    ] });
    const r = await call(srv, "POST", "/api/auth/delete", { token: acc.token, body: { password: PASSWORD } });
    assert.equal(r.status, 200);
    assert.equal((await me(srv, acc.token)).status, 401);
    assert.equal((await me(srv, other)).status, 401);
    assert.equal((await sync(srv, other)).status, 401);
    const db = srv.db();
    try {
      const acct = `u:${acc.user.id}`;
      assert.equal(db.prepare("SELECT COUNT(*) n FROM records WHERE account=?").get(acct).n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE user=?").get(acc.user.id).n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE id=?").get(acc.user.id).n, 0);
    } finally { db.close(); }
    const again = await register(srv, { email: acc.email });
    assert.notEqual(again.user.id, acc.user.id);
    const pulled = await sync(srv, again.token, { deviceId: "novo" });
    assert.equal(pulled.status, 200);
    assert.deepEqual(pulled.body.records, []);
  });

  it("C9 quando apago com a senha errada, então 403 e nada é apagado", async () => {
    const acc = await register(srv);
    await sync(srv, acc.token, { deviceId: "d1", changes: [{ kind: "setting", id: "s1", updatedAt: Date.now(), value: 1 }] });
    const r = await call(srv, "POST", "/api/auth/delete", { token: acc.token, body: { password: "errada-123" } });
    assert.equal(r.status, 403);
    assert.equal((await me(srv, acc.token)).status, 200);
    assert.equal((await sync(srv, acc.token, { deviceId: "d2" })).body.records.length, 1);
  });

  it("C10 quando mando \"apagar conta\" 2 vezes ao mesmo tempo, então uma dá 200 e a outra 401/403, e o processo não cai", async () => {
    const acc = await register(srv);
    const rs = await Promise.all([1, 2].map(() =>
      call(srv, "POST", "/api/auth/delete", { token: acc.token, body: { password: PASSWORD } })));
    const statuses = rs.map((r) => r.status).sort();
    assert.equal(statuses[0], 200);
    assert.ok([401, 403].includes(statuses[1]), `statuses: ${statuses}`);
    assert.equal((await call(srv, "GET", "/api/health")).status, 200);
  });
});
