// D. Sincronização — POST /api/sync
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, call, register, sync } from "./helpers.mjs";

const card = (id, updatedAt, value = { v: updatedAt }, extra = {}) => ({ kind: "card", id, updatedAt, value, ...extra });
const find = (records, kind, id) => records.find((r) => r.kind === kind && r.id === id);

describe("D. Sincronização", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => { await srv.stop(); });

  it("D1 quando subo registros e outro aparelho pede since 0, então ele recebe tudo e o seq cresce", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    const up = await sync(srv, token, { deviceId: "celular", changes: [
      card("c1", now), { kind: "review", id: "r1", updatedAt: now, value: { g: 3 } },
      { kind: "doseProgress", id: "ko-A1-01", updatedAt: now, value: { done: true } },
    ] });
    assert.equal(up.status, 200);
    assert.equal(up.body.accepted, 3);
    assert.equal(up.body.seq, 3);
    const down = await sync(srv, token, { deviceId: "desktop" });
    assert.equal(down.body.records.length, 3);
    assert.deepEqual(find(down.body.records, "doseProgress", "ko-A1-01").value, { done: true });
  });

  it("D2 quando o aparelho que subiu pede de novo, então não recebe de volta o próprio upload (sem eco)", async () => {
    const { token } = await register(srv);
    await sync(srv, token, { deviceId: "celular", changes: [card("c1", Date.now())] });
    const again = await sync(srv, token, { deviceId: "celular" });
    assert.deepEqual(again.body.records, []);
  });

  it("D3 quando peço since N, então só vem o que tem seq > N", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    await sync(srv, token, { deviceId: "a", changes: [card("c1", now), card("c2", now), card("c3", now)] });
    const r = await sync(srv, token, { deviceId: "b", since: 2 });
    assert.deepEqual(r.body.records.map((x) => x.id), ["c3"]);
  });

  it("D4 quando há mais de 2000 registros, então vêm 2000 com hasMore e a página seguinte traz o resto sem repetir nem pular", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    const changes = Array.from({ length: 2100 }, (_, i) => ({ kind: "review", id: `r${i}`, updatedAt: now, value: { i } }));
    assert.equal((await sync(srv, token, { deviceId: "a", changes })).body.accepted, 2100);
    const p1 = await sync(srv, token, { deviceId: "b" });
    assert.equal(p1.body.records.length, 2000);
    assert.equal(p1.body.hasMore, true);
    const last = Math.max(...p1.body.records.map((r) => r.seq));
    const p2 = await sync(srv, token, { deviceId: "b", since: last });
    assert.equal(p2.body.hasMore, false);
    const ids = new Set([...p1.body.records, ...p2.body.records].map((r) => r.id));
    assert.equal(ids.size, 2100);
    assert.equal(p1.body.records.length + p2.body.records.length, 2100);
  });

  it("D5 estado: versão mais velha é ignorada (accepted 0); mais nova vence", async () => {
    const { token } = await register(srv);
    const t = Date.now() - 60_000;
    await sync(srv, token, { deviceId: "a", changes: [card("c1", t, { v: "meio" })] });
    const old = await sync(srv, token, { deviceId: "b", changes: [card("c1", t - 1000, { v: "velho" })] });
    assert.equal(old.body.accepted, 0);
    const neu = await sync(srv, token, { deviceId: "b", changes: [card("c1", t + 1000, { v: "novo" })] });
    assert.equal(neu.body.accepted, 1);
    const r = await sync(srv, token, { deviceId: "c" });
    assert.deepEqual(find(r.body.records, "card", "c1").value, { v: "novo" });
  });

  it("D6 estado com updatedAt empatado: o tombstone vence e uma versão comum empatada não ressuscita", async () => {
    const { token } = await register(srv);
    const t = Date.now() - 60_000;
    await sync(srv, token, { deviceId: "a", changes: [card("c1", t, { v: 1 })] });
    const del = await sync(srv, token, { deviceId: "b", changes: [card("c1", t, null, { deleted: true })] });
    assert.equal(del.body.accepted, 1);
    const back = await sync(srv, token, { deviceId: "a", changes: [card("c1", t, { v: 2 })] });
    assert.equal(back.body.accepted, 0);
    const r = await sync(srv, token, { deviceId: "c" });
    assert.equal(find(r.body.records, "card", "c1").deleted, true);
  });

  it("D7 evento: reenvio com outro conteúdo não muda o original; tombstone apaga para sempre", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    await sync(srv, token, { deviceId: "a", changes: [{ kind: "review", id: "r1", updatedAt: now, value: { g: 3 } }] });
    const dup = await sync(srv, token, { deviceId: "b", changes: [{ kind: "review", id: "r1", updatedAt: now + 5, value: { g: 1 } }] });
    assert.equal(dup.body.accepted, 0);
    let r = await sync(srv, token, { deviceId: "c" });
    assert.deepEqual(find(r.body.records, "review", "r1").value, { g: 3 });
    await sync(srv, token, { deviceId: "b", changes: [{ kind: "review", id: "r1", updatedAt: now, deleted: true }] });
    const revive = await sync(srv, token, { deviceId: "a", changes: [{ kind: "review", id: "r1", updatedAt: now + 99_000, value: { g: 3 } }] });
    assert.equal(revive.body.accepted, 0);
    r = await sync(srv, token, { deviceId: "c" });
    assert.equal(find(r.body.records, "review", "r1").deleted, true);
  });

  it("D8 quando kind é desconhecido ou id vazio, então o registro é ignorado e os outros do lote entram", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    const r = await sync(srv, token, { deviceId: "a", changes: [
      { kind: "hacker", id: "x", updatedAt: now, value: 1 },
      { kind: "card", id: "", updatedAt: now, value: 1 },
      { kind: "card", id: 42, updatedAt: now, value: 1 },
      card("ok", now),
    ] });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, 1);
  });

  it("D8b quando um item do lote é null ou não é objeto, então ele é ignorado e os outros entram (não 500)", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    const r = await sync(srv, token, { deviceId: "a", changes: [null, 7, "x", card("ok", now)] });
    assert.equal(r.status, 200);
    assert.equal(r.body.accepted, 1);
  });

  it("D9 quando o updatedAt vem 1 ano no futuro, então é cortado em até 5 min à frente e uma escrita posterior consegue vencê-lo", async () => {
    const { token } = await register(srv);
    const sent = Date.now();
    await sync(srv, token, { deviceId: "a", changes: [card("c1", sent + 365 * 864e5, { v: "futuro" })] });
    let r = await sync(srv, token, { deviceId: "b" });
    const stored = find(r.body.records, "card", "c1").updatedAt;
    assert.ok(stored <= Date.now() + 5 * 60_000, `updatedAt guardado ${stored - Date.now()} ms no futuro`);
    const win = await sync(srv, token, { deviceId: "b", changes: [card("c1", stored + 1, { v: "legítimo" })] });
    assert.equal(win.body.accepted, 1);
    r = await sync(srv, token, { deviceId: "c" });
    assert.deepEqual(find(r.body.records, "card", "c1").value, { v: "legítimo" });
  });

  it("D10 quando o updatedAt é 0, negativo ou não numérico, então vale a hora do servidor", async () => {
    const { token } = await register(srv);
    const before = Date.now();
    const r0 = await sync(srv, token, { deviceId: "a", changes: [
      card("zero", 0), card("neg", -5000), card("txt", "ontem"),
    ] });
    assert.equal(r0.status, 200);
    const after = Date.now();
    const r = await sync(srv, token, { deviceId: "b" });
    for (const id of ["zero", "neg", "txt"]) {
      const u = find(r.body.records, "card", id).updatedAt;
      assert.ok(u >= before && u <= after, `${id}: updatedAt=${u}, esperado entre ${before} e ${after}`);
    }
  });

  it("D11 quando 2 aparelhos mandam o mesmo card ao mesmo tempo, então o maior updatedAt vence em qualquer ordem", async () => {
    const { token } = await register(srv);
    const t = Date.now() - 60_000;
    for (const [first, second] of [["a", "b"], ["b", "a"]]) {
      const id = `race-${first}`;
      const by = { a: card(id, t, { v: "velho" }), b: card(id, t + 10, { v: "novo" }) };
      await Promise.all([
        sync(srv, token, { deviceId: first, changes: [by[first]] }),
        sync(srv, token, { deviceId: second, changes: [by[second]] }),
      ]);
      const r = await sync(srv, token, { deviceId: "leitor" });
      assert.deepEqual(find(r.body.records, "card", id).value, { v: "novo" }, `ordem ${first}→${second}`);
    }
  });

  it("D12a quando o mesmo lote é reenviado (retry), então a 2ª vez dá accepted 0 e nada duplica", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    const changes = [card("c1", now), { kind: "review", id: "r1", updatedAt: now, value: { g: 3 } },
                     { kind: "setting", id: "srs", updatedAt: now, value: { a: 1 } }];
    const first = await sync(srv, token, { deviceId: "a", changes });
    const second = await sync(srv, token, { deviceId: "a", changes });
    assert.equal(first.body.accepted, 3);
    assert.equal(second.body.accepted, 0);
    assert.equal(second.body.seq, first.body.seq);
    assert.equal((await sync(srv, token, { deviceId: "b" })).body.records.length, 3);
  });

  it("D12b quando um lote com apagamento (tombstone de card) é reenviado, então a 2ª vez dá accepted 0 e o seq não anda", async () => {
    const { token } = await register(srv);
    const t = Date.now() - 1000;
    await sync(srv, token, { deviceId: "a", changes: [card("c1", t - 1000)] });
    const changes = [card("c1", t, null, { deleted: true })];
    const first = await sync(srv, token, { deviceId: "a", changes });
    const second = await sync(srv, token, { deviceId: "a", changes });
    assert.equal(first.body.accepted, 1);
    assert.equal(second.body.accepted, 0);
    assert.equal(second.body.seq, first.body.seq);
  });

  it("D12c quando o mesmo lote chega 2 vezes ao mesmo tempo, então o efeito acontece uma vez só (accepted soma 3, seq anda 3)", async () => {
    const { token } = await register(srv);
    const now = Date.now();
    const changes = [card("c1", now), { kind: "review", id: "r1", updatedAt: now, value: { g: 3 } },
                     { kind: "mark", id: "m1", updatedAt: now, value: { s: 1 } }];
    const [a, b] = await Promise.all([
      sync(srv, token, { deviceId: "a", changes }),
      sync(srv, token, { deviceId: "a", changes }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.accepted + b.body.accepted, 3);
    assert.equal(Math.max(a.body.seq, b.body.seq), 3);
    const down = await sync(srv, token, { deviceId: "b" });
    assert.equal(down.body.records.length, 3);
    assert.equal(down.body.seq, 3);
  });

  it("D13 quando o corpo passa de 12 MB, então 413 (não 500) e o processo segue de pé", async () => {
    const { token } = await register(srv);
    const raw = JSON.stringify({ changes: [card("big", Date.now(), "x".repeat(13 * 1024 * 1024))] });
    const r = await call(srv, "POST", "/api/sync", { token, raw }).catch((e) => ({ status: "conexão", err: e }));
    assert.equal(r.status, 413);
    assert.equal((await call(srv, "GET", "/api/health")).status, 200);
  });

  it("D14 sem credencial, código < 12 caracteres ou imt_ inválido → 401; GET → 405; JSON inválido → 400", async () => {
    assert.equal((await sync(srv, undefined)).status, 401);
    assert.equal((await sync(srv, "curto-11cha")).status, 401);
    assert.equal((await sync(srv, "imt_naoexiste-0000000000000")).status, 401);
    assert.equal((await call(srv, "GET", "/api/sync")).status, 405);
    const { token } = await register(srv);
    assert.equal((await call(srv, "POST", "/api/sync", { token, raw: "{quebrado" })).status, 400);
    assert.equal((await call(srv, "POST", "/api/sync", { token, raw: "[]" })).status, 400);
  });
});
