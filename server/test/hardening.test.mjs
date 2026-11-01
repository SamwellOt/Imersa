// F. Proteções contra abuso: fila do scrypt, aparelho confiável e disjuntor de cadastros
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, call, register, login, uniqueEmail, nextIp, PASSWORD } from "./helpers.mjs";
import { openStore } from "../sync-store.mjs";
import { openAuth, kdfStats } from "../auth-store.mjs";

const me = (srv, token) => call(srv, "GET", "/api/auth/me", { token });

/** Ataque espalhado: cada chute de um IP diferente (o limite por IP não pega). */
async function distributedAttack(srv, email, n = 9) {
  for (let i = 0; i < n; i++) await login(srv, email, "chute-errado", { ip: nextIp() });
}

describe("F1. Fila do scrypt (sem barrar ninguém)", () => {
  // Aqui o auth-store roda direto (código de verdade, SQLite temporário de verdade):
  // é a única forma de ler quantos scrypts rodaram juntos.
  let dir, store, auth;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "imersa-kdf-"));
    store = openStore(join(dir, "kdf.sqlite"));
    auth = openAuth(store.db);
  });
  after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("F1a quando chegam 20 cadastros válidos ao mesmo tempo, então todos são criados e no máximo 4 scrypts rodam juntos", async () => {
    const rs = await Promise.allSettled(Array.from({ length: 20 }, (_, i) =>
      auth.register({ email: uniqueEmail(`fila${i}`), password: PASSWORD, ip: `10.0.0.${i}` })));
    assert.deepEqual(rs.map((r) => r.status), Array(20).fill("fulfilled"));
    const st = kdfStats();
    assert.ok(st.peak <= 4, `pico de ${st.peak} scrypts simultâneos`);
    assert.equal(st.running, 0);
    assert.equal(st.queued, 0);
  });
});

describe("F1b. Fila do scrypt pela rota", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("F1b quando chegam 20 cadastros válidos ao mesmo tempo pela rota, então todos dão 201", async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () =>
      call(srv, "POST", "/api/auth/register", { body: { email: uniqueEmail("rajada"), password: PASSWORD }, ip: nextIp() })));
    assert.deepEqual(rs.map((r) => r.status), Array(20).fill(201));
  });
});

describe("F2–F6. Aparelho confiável", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("F0 quando crio a conta ou entro, então recebo uma marca imd_; entrando com ela, a mesma marca volta", async () => {
    const acc = await register(srv);
    assert.match(acc.deviceTrust, /^imd_/);
    const r = await login(srv, acc.email, PASSWORD, { deviceTrust: acc.deviceTrust });
    assert.equal(r.status, 200);
    assert.equal(r.body.deviceTrust, acc.deviceTrust);
    const fresh = await login(srv, acc.email);
    assert.match(fresh.body.deviceTrust, /^imd_/);
    assert.notEqual(fresh.body.deviceTrust, acc.deviceTrust);
  });

  it("F2 quando 9+ IPs diferentes erram a senha da mesma conta, então a próxima tentativa de aparelho sem marca dá 429 (até com a senha certa)", async () => {
    const acc = await register(srv);
    await distributedAttack(srv, acc.email);
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 429);
  });

  it("F3 durante esse bloqueio, quando o dono entra do aparelho com marca e senha certa, então 200", async () => {
    const acc = await register(srv);
    await distributedAttack(srv, acc.email);
    const r = await login(srv, acc.email, PASSWORD, { deviceTrust: acc.deviceTrust });
    assert.equal(r.status, 200);
    // e o dono entrar não destrava a conta para os estranhos
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 429);
  });

  it("F3b quando a marca é usada com a senha errada 8 vezes, então ela também é bloqueada (marca roubada não chuta à vontade)", async () => {
    const acc = await register(srv);
    for (let i = 0; i < 8; i++) {
      assert.equal((await login(srv, acc.email, "errada-xxx", { deviceTrust: acc.deviceTrust })).status, 401);
    }
    assert.equal((await login(srv, acc.email, PASSWORD, { deviceTrust: acc.deviceTrust })).status, 429);
  });

  it("F4 quando a marca é de outra conta ou inventada, então não fura o bloqueio", async () => {
    const victim = await register(srv);
    const other = await register(srv);
    await distributedAttack(srv, victim.email);
    for (const deviceTrust of [other.deviceTrust, "imd_inventada-000000000000000000000000", "x".repeat(5000)]) {
      assert.equal((await login(srv, victim.email, PASSWORD, { deviceTrust })).status, 429);
    }
  });

  it("F5 quando o dono troca a senha, então as marcas dos outros aparelhos deixam de valer e a do aparelho que trocou continua", async () => {
    const acc = await register(srv); // aparelho 1 (o que vai trocar a senha)
    const dev2 = (await login(srv, acc.email)).body; // aparelho 2, com marca própria
    const r = await call(srv, "POST", "/api/auth/password", { token: acc.token, body: { current: PASSWORD, next: "nova-senha-789" } });
    assert.equal(r.status, 200);
    await distributedAttack(srv, acc.email);
    assert.equal((await login(srv, acc.email, "nova-senha-789", { deviceTrust: dev2.deviceTrust })).status, 429);
    assert.equal((await login(srv, acc.email, "nova-senha-789", { deviceTrust: acc.deviceTrust })).status, 200);
  });

  it("F5b quando encerro um aparelho nos Ajustes, então a marca dele deixa de valer", async () => {
    const acc = await register(srv);
    const dev2 = (await login(srv, acc.email)).body;
    await call(srv, "POST", "/api/auth/sessions/revoke", { token: acc.token, body: { id: dev2.sessionId } });
    await distributedAttack(srv, acc.email);
    assert.equal((await login(srv, acc.email, PASSWORD, { deviceTrust: dev2.deviceTrust })).status, 429);
    assert.equal((await login(srv, acc.email, PASSWORD, { deviceTrust: acc.deviceTrust })).status, 200);
  });

  it("F6 quando saio da conta, então a marca continua valendo na próxima entrada", async () => {
    const acc = await register(srv);
    assert.equal((await call(srv, "POST", "/api/auth/logout", { token: acc.token })).status, 200);
    await distributedAttack(srv, acc.email);
    const r = await login(srv, acc.email, PASSWORD, { deviceTrust: acc.deviceTrust });
    assert.equal(r.status, 200);
    assert.equal((await me(srv, r.body.token)).status, 200);
  });

  it("F6b quando apago a conta, então as marcas dela somem do banco", async () => {
    const acc = await register(srv);
    await call(srv, "POST", "/api/auth/delete", { token: acc.token, body: { password: PASSWORD } });
    const db = srv.db();
    try {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM trusted_devices WHERE user=?").get(acc.user.id).n, 0);
    } finally { db.close(); }
  });

  it("F6c a marca nunca fica em claro no banco (só o hash)", async () => {
    const acc = await register(srv);
    const db = srv.db();
    try {
      const row = db.prepare("SELECT * FROM trusted_devices WHERE user=?").get(acc.user.id);
      assert.ok(row);
      assert.ok(!JSON.stringify(row).includes(acc.deviceTrust.slice(4)));
    } finally { db.close(); }
  });
});

describe("F7. Disjuntor de cadastros (teto global por hora)", () => {
  let srv;
  // teto baixo só neste servidor de teste; o padrão de produção é 100/hora
  before(async () => { srv = await startServer({ env: { IMERSA_SIGNUP_MAX_PER_HOUR: "5" } }); });
  after(async () => { await srv.stop(); });

  it("F7a quando o servidor inteiro passa do teto de contas novas na hora, então o próximo cadastro (de qualquer IP) dá 429", async () => {
    const rs = [];
    for (let i = 0; i < 6; i++) {
      rs.push((await call(srv, "POST", "/api/auth/register", { body: { email: uniqueEmail("teto"), password: PASSWORD }, ip: nextIp() })).status);
    }
    assert.deepEqual(rs, [201, 201, 201, 201, 201, 429]);
  });

  it("F7b com o teto estourado, quem já tem conta continua entrando normalmente", async () => {
    const db = srv.db();
    let email;
    try { email = db.prepare("SELECT email FROM users LIMIT 1").get().email; } finally { db.close(); }
    assert.equal((await login(srv, email)).status, 200);
  });

  it("F7c cadastro inválido não consome vaga do teto", async () => {
    const s2 = await startServer({ env: { IMERSA_SIGNUP_MAX_PER_HOUR: "2" } });
    try {
      for (let i = 0; i < 3; i++) {
        await call(s2, "POST", "/api/auth/register", { body: { email: "invalido", password: PASSWORD }, ip: nextIp() });
      }
      const ok = await call(s2, "POST", "/api/auth/register", { body: { email: uniqueEmail(), password: PASSWORD }, ip: nextIp() });
      assert.equal(ok.status, 201);
    } finally { await s2.stop(); }
  });

  it("F7d quando 10 cadastros chegam ao mesmo tempo com teto 5, então exatamente 5 passam e 5 dão 429", async () => {
    const s3 = await startServer({ env: { IMERSA_SIGNUP_MAX_PER_HOUR: "5" } });
    try {
      const rs = await Promise.all(Array.from({ length: 10 }, () =>
        call(s3, "POST", "/api/auth/register", { body: { email: uniqueEmail("corrida"), password: PASSWORD }, ip: nextIp() })));
      assert.equal(rs.filter((r) => r.status === 201).length, 5);
      assert.equal(rs.filter((r) => r.status === 429).length, 5);
    } finally { await s3.stop(); }
  });
});
