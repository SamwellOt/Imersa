// G–J. Correções da auditoria de segurança de 31/10/2026:
//   G. código legado não cria conta nova
//   H. limites de armazenamento (por registro e cota por conta)
//   I. senha atual com limite de tentativas (trocar senha / apagar conta)
//   J. disjuntor global de "e-mail já cadastrado" (enumeração espalhada por IPs)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  startServer, call, register, login, sync, nextIp, uniqueEmail, PASSWORD,
} from "./helpers.mjs";
import { openStore } from "../sync-store.mjs";

const card = (id, value = { v: 1 }, updatedAt = Date.now()) => ({ kind: "card", id, updatedAt, value });
const count = (srv, sql, ...args) => {
  const db = srv.db();
  try { return db.prepare(sql).get(...args).n; } finally { db.close(); }
};

describe("G. Código de sincronização legado", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("G1 quando um código que o servidor não conhece chega no /api/sync ou /api/stats, então 401 e nenhuma conta é criada", async () => {
    const before = count(srv, "SELECT COUNT(*) n FROM accounts");
    const code = "codigo-inventado-que-nunca-existiu";
    const r = await sync(srv, code, { deviceId: "x", changes: [card("invasor")] });
    assert.equal(r.status, 401);
    assert.equal((await call(srv, "GET", "/api/stats", { token: code })).status, 401);
    assert.equal(count(srv, "SELECT COUNT(*) n FROM accounts"), before);
    assert.equal(count(srv, "SELECT COUNT(*) n FROM records WHERE id='invasor'"), 0);
  });
});

describe("H. Limites de armazenamento", () => {
  let srv;
  before(async () => {
    srv = await startServer({ env: { IMERSA_QUOTA_RECORDS: "10", IMERSA_QUOTA_BYTES: "4000" } });
  });
  after(async () => { await srv.stop(); });

  it("H1 quando um registro tem id com mais de 200 caracteres ou value com mais de 256 KB, então ele é ignorado e os outros do lote entram", async () => {
    const A = await register(srv);
    const r = await sync(srv, A.token, { deviceId: "a1", changes: [
      card("x".repeat(201)),
      { kind: "setting", id: "enorme", updatedAt: Date.now(), value: { s: "y".repeat(257 * 1024) } },
      card("normal"),
    ] });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, 1);
    const pulled = await sync(srv, A.token, { deviceId: "a2" });
    assert.deepEqual(pulled.body.records.map((x) => x.id), ["normal"]);
  });

  it("H2 quando o lote faria a conta passar da cota de registros, então 507, nada do lote é gravado e o que já estava continua", async () => {
    const A = await register(srv);
    const first = Array.from({ length: 8 }, (_, i) => card(`c${i}`));
    assert.equal((await sync(srv, A.token, { deviceId: "a1", changes: first })).body.accepted, 8);
    const more = Array.from({ length: 5 }, (_, i) => card(`novo${i}`));
    const r = await sync(srv, A.token, { deviceId: "a1", changes: more });
    assert.equal(r.status, 507);
    assert.match(r.body.error, /Cota/);
    const pulled = await sync(srv, A.token, { deviceId: "a2" });
    assert.equal(pulled.body.records.length, 8);
    assert.ok(!pulled.body.records.some((x) => x.id.startsWith("novo")));
  });

  it("H3 com a conta na cota, apagar e atualizar com valor menor continuam aceitos; registro novo dá 507", async () => {
    const A = await register(srv);
    const t = Date.now() - 60_000;
    const full = Array.from({ length: 10 }, (_, i) => card(`c${i}`, { s: "z".repeat(50) }, t));
    assert.equal((await sync(srv, A.token, { deviceId: "a1", changes: full })).body.accepted, 10);
    const shrink = await sync(srv, A.token, { deviceId: "a1", changes: [
      { kind: "card", id: "c0", updatedAt: t + 1000, deleted: true },
      card("c1", { s: "z" }, t + 1000),
    ] });
    assert.equal(shrink.status, 200);
    assert.equal(shrink.body.accepted, 2);
    assert.equal((await sync(srv, A.token, { deviceId: "a1", changes: [card("c10")] })).status, 507);
  });

  it("H4 quando o lote faria a conta passar da cota de bytes, então 507 e só o que coube antes fica", async () => {
    const A = await register(srv);
    const big = (id) => card(id, { s: "b".repeat(1500) });
    assert.equal((await sync(srv, A.token, { deviceId: "a1", changes: [big("b1"), big("b2")] })).status, 200);
    assert.equal((await sync(srv, A.token, { deviceId: "a1", changes: [big("b3")] })).status, 507);
    const pulled = await sync(srv, A.token, { deviceId: "a2" });
    assert.deepEqual(pulled.body.records.map((x) => x.id).sort(), ["b1", "b2"]);
  });

  it("H5 a cota é de cada conta: uma conta cheia não impede outra de gravar", async () => {
    const A = await register(srv);
    const B = await register(srv);
    const ten = Array.from({ length: 10 }, (_, i) => card(`c${i}`));
    await sync(srv, A.token, { deviceId: "a1", changes: ten });
    assert.equal((await sync(srv, A.token, { deviceId: "a1", changes: [card("extra")] })).status, 507);
    const rb = await sync(srv, B.token, { deviceId: "b1", changes: [card("de-B")] });
    assert.equal(rb.status, 200);
    assert.equal(rb.body.accepted, 1);
  });

  it("H6 um banco de antes da cota, ao abrir, ganha os contadores preenchidos a partir dos registros que já tinha", () => {
    const dir = mkdtempSync(join(tmpdir(), "imersa-test-"));
    try {
      const file = join(dir, "antigo.sqlite");
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE records (account TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
          seq INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
          json TEXT, device TEXT, PRIMARY KEY (account, kind, id));
        CREATE TABLE accounts (account TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0,
          created INTEGER NOT NULL, lastSeen INTEGER NOT NULL);
        INSERT INTO accounts VALUES ('u:x', 3, 0, 0);
        INSERT INTO records VALUES ('u:x', 'card', 'a', 1, 1, 0, '{"v":1}', NULL);
        INSERT INTO records VALUES ('u:x', 'card', 'bb', 2, 1, 0, '"é"', NULL);
        INSERT INTO records VALUES ('u:x', 'card', 'ccc', 3, 1, 1, NULL, NULL);
      `);
      old.close();
      const store = openStore(file);
      const row = store.db.prepare("SELECT nrec, nbytes FROM accounts WHERE account='u:x'").get();
      // ids: 1 + 2 + 3 bytes; json: 7 + 4 ("é" tem 2 bytes em UTF-8) + 0 (tombstone)
      assert.deepEqual({ ...row }, { nrec: 3, nbytes: 6 + 11 });
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("I. Senha atual com limite de tentativas", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("I1 quando a senha atual está errada algumas vezes (< 8) e depois certa, então a troca funciona", async () => {
    const A = await register(srv);
    for (let i = 0; i < 3; i++) {
      const r = await call(srv, "POST", "/api/auth/password", { token: A.token, body: { current: "errada-123", next: "nova-senha-1" } });
      assert.equal(r.status, 403);
    }
    const ok = await call(srv, "POST", "/api/auth/password", { token: A.token, body: { current: PASSWORD, next: "nova-senha-1" } });
    assert.equal(ok.status, 200);
  });

  it("I2 quando um token chuta a senha atual 8 vezes, então a 9ª dá 429 até com a senha certa, e a senha não muda", async () => {
    const A = await register(srv);
    for (let i = 0; i < 8; i++) {
      await call(srv, "POST", "/api/auth/password", { token: A.token, body: { current: `chute-${i}-xx`, next: "do-invasor-1" } });
    }
    const r = await call(srv, "POST", "/api/auth/password", { token: A.token, body: { current: PASSWORD, next: "do-invasor-1" } });
    assert.equal(r.status, 429);
    assert.equal((await login(srv, A.email, PASSWORD)).status, 200, "o dono continua entrando com a senha dele");
    assert.equal((await login(srv, A.email, "do-invasor-1")).status, 401);
  });

  it("I3 o mesmo limite vale para apagar a conta: depois de 8 chutes, apagar dá 429 e a conta continua", async () => {
    const A = await register(srv);
    for (let i = 0; i < 8; i++) {
      await call(srv, "POST", "/api/auth/delete", { token: A.token, body: { password: `chute-${i}-xx` } });
    }
    const r = await call(srv, "POST", "/api/auth/delete", { token: A.token, body: { password: PASSWORD } });
    assert.equal(r.status, 429);
    assert.equal((await call(srv, "GET", "/api/auth/me", { token: A.token })).status, 200);
  });
});

describe("J. Disjuntor de e-mail já cadastrado", () => {
  let srv, A;
  before(async () => {
    srv = await startServer({ env: { IMERSA_REGDUP_MAX_PER_HOUR: "3" } });
    A = await register(srv);
  });
  after(async () => { await srv.stop(); });

  const tryRegister = (email) =>
    call(srv, "POST", "/api/auth/register", { body: { email, password: PASSWORD }, ip: nextIp() });

  it("J1 cadastro com e-mail inválido não conta para o disjuntor", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await tryRegister(`ruim${i}`)).status, 400);
    assert.equal((await tryRegister(uniqueEmail())).status, 201);
  });

  it("J2 quando IPs diferentes batem 3 vezes em e-mail já cadastrado, então o próximo cadastro de QUALQUER e-mail (até novo) dá 429, e entrar continua funcionando", async () => {
    for (let i = 0; i < 3; i++) assert.equal((await tryRegister(A.email)).status, 409);
    assert.equal((await tryRegister(A.email)).status, 429);
    assert.equal((await tryRegister(uniqueEmail())).status, 429, "e-mail novo também espera: senão o 429 entregaria quem existe");
    assert.equal((await login(srv, A.email)).status, 200);
  });
});
