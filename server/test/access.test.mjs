// E. Acesso indevido (conta A × conta B) e arquivos fora das pastas públicas
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, call, register, login, sync, PASSWORD } from "./helpers.mjs";
import { accountId } from "../sync-store.mjs";

const card = (id, updatedAt, value) => ({ kind: "card", id, updatedAt, value });

describe("E. Acesso indevido", () => {
  let srv, A, B;
  before(async () => {
    srv = await startServer();
    A = await register(srv, { name: "A" });
    B = await register(srv, { name: "B" });
  });
  after(async () => { await srv.stop(); });

  it("E1 quando A e B sobem progresso, então o since 0 de cada um só traz os próprios dados", async () => {
    const now = Date.now();
    await sync(srv, A.token, { deviceId: "a1", changes: [card("so-de-A", now, { dono: "A" })] });
    await sync(srv, B.token, { deviceId: "b1", changes: [card("so-de-B", now, { dono: "B" })] });
    const ra = await sync(srv, A.token, { deviceId: "a2" });
    const rb = await sync(srv, B.token, { deviceId: "b2" });
    assert.ok(ra.body.records.every((r) => r.value?.dono !== "B"));
    assert.ok(rb.body.records.every((r) => r.value?.dono !== "A"));
    assert.ok(ra.body.records.some((r) => r.id === "so-de-A"));
    assert.ok(rb.body.records.some((r) => r.id === "so-de-B"));
  });

  it("E2 quando A sobe registro com o mesmo kind+id de um de B (até mais novo), então o de B não muda", async () => {
    const t = Date.now() - 60_000;
    await sync(srv, B.token, { deviceId: "b1", changes: [card("ko-A1-01::w-있다", t, { dono: "B" })] });
    await sync(srv, A.token, { deviceId: "a1", changes: [
      card("ko-A1-01::w-있다", t + 50_000, { dono: "A-invasor" }),
      { kind: "card", id: "ko-A1-01::w-있다", updatedAt: t + 50_001, deleted: true },
    ] });
    const rb = await sync(srv, B.token, { deviceId: "b-leitor" });
    const rec = rb.body.records.find((r) => r.id === "ko-A1-01::w-있다");
    assert.equal(rec.deleted, false);
    assert.deepEqual(rec.value, { dono: "B" });
  });

  it("E3 quando A tenta encerrar uma sessão de B pelo id, então a sessão de B continua viva", async () => {
    const r = await call(srv, "POST", "/api/auth/sessions/revoke", { token: A.token, body: { id: B.sessionId } });
    assert.notEqual(r.status, 500);
    assert.ok(!r.body.sessions?.some((s) => s.id === B.sessionId), "lista de A não pode conter sessão de B");
    assert.equal((await call(srv, "GET", "/api/auth/me", { token: B.token })).status, 200);
  });

  it("E4 quando A apaga a própria conta, então progresso e sessões de B ficam intactos", async () => {
    const victim = await register(srv);
    const other = await register(srv);
    const now = Date.now();
    await sync(srv, other.token, { deviceId: "o1", changes: [card("x", now, { dono: "outro" })] });
    const before = (await sync(srv, other.token, { deviceId: "o2" })).body.records.length;
    const del = await call(srv, "POST", "/api/auth/delete", { token: victim.token, body: { password: PASSWORD } });
    assert.equal(del.status, 200);
    assert.equal((await call(srv, "GET", "/api/auth/me", { token: other.token })).status, 200);
    assert.equal((await sync(srv, other.token, { deviceId: "o3" })).body.records.length, before);
  });

  it("E5 o código de sincronização legado vive num espaço próprio: não vê conta nenhuma e vice-versa", async () => {
    const code = "codigo-legado-de-teste-123";
    const now = Date.now();
    // o código legado só vale para conta que já existe (G1): a fixture a cria no banco
    const db = srv.db();
    db.prepare("INSERT INTO accounts (account, seq, created, lastSeen) VALUES (?, 0, ?, ?)")
      .run(accountId(code), now, now);
    db.close();
    await sync(srv, code, { deviceId: "l1", changes: [card("do-legado", now, { dono: "legado" })] });
    const rl = await sync(srv, code, { deviceId: "l2" });
    assert.deepEqual(rl.body.records.map((r) => r.id), ["do-legado"]);
    const ra = await sync(srv, A.token, { deviceId: "a9" });
    assert.ok(!ra.body.records.some((r) => r.id === "do-legado"));
    // um "código" igual ao nome interno da conta não abre a conta
    const spoof = await sync(srv, `u:${A.user.id}`, { deviceId: "x" });
    assert.ok(!spoof.body.records?.some((r) => r.value?.dono === "A"));
  });

  it("E6 /me e /api/stats de A só mostram as sessões e números de A", async () => {
    const extraB = (await login(srv, B.email)).body.sessionId;
    const me = await call(srv, "GET", "/api/auth/me", { token: A.token });
    assert.equal(me.body.user.id, A.user.id);
    const ids = me.body.sessions.map((s) => s.id);
    assert.ok(!ids.includes(B.sessionId) && !ids.includes(extraB));
    const statsA = await call(srv, "GET", "/api/stats", { token: A.token });
    const pulledA = (await sync(srv, A.token, { deviceId: "a-stats" })).body.records.filter((r) => !r.deleted);
    assert.equal(statsA.status, 200);
    assert.equal(statsA.body.card ?? 0, pulledA.filter((r) => r.kind === "card").length);
    assert.equal(me.body.user.email, A.email);
  });

  it("E7 quando peço o banco por path traversal em /content e no app, então nunca é servido", async () => {
    const paths = [
      "/content/../server/data/imersa.sqlite",
      "/content/%2e%2e/server/data/imersa.sqlite",
      "/content/..%2fserver%2fdata%2fimersa.sqlite",
      "/content/%2e%2e%2fserver%2fdata%2fimersa.sqlite",
      "/content/....//server/data/imersa.sqlite",
      "/content/..%5cserver%5cdata%5cimersa.sqlite",
      "/content/%00../server/data/imersa.sqlite",
      "/../server/data/imersa.sqlite",
      "/..%2fserver%2fdata%2fimersa.sqlite",
      "/assets/..%2f..%2f..%2fserver%2fdata%2fimersa.sqlite",
      "/..%2f..%2fserver%2fauth-store.mjs",
    ];
    for (const p of paths) {
      const r = await call(srv, "GET", p);
      assert.ok(!r.buf.subarray(0, 16).toString("latin1").startsWith("SQLite format"), `${p} serviu o banco!`);
      assert.ok(!r.text.includes("scrypt"), `${p} serviu código do servidor!`);
      assert.ok([400, 404, 503].includes(r.status) || (r.status === 200 && r.headers["content-type"]?.startsWith("text/html")),
        `${p} → ${r.status} ${r.headers["content-type"]}`);
    }
  });
});
