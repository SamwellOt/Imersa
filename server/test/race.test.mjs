// R. Condições de corrida: dois pedidos que leem, decidem e gravam ao mesmo tempo.
//
// O servidor é um processo só e o node:sqlite é síncrono, então só existe corrida
// onde há um `await` entre a checagem e a gravação: a chegada do corpo e o scrypt
// (~50 ms). Cada teste abre essa janela de propósito e prova que só um pedido tem
// efeito.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startServer, call, register, login, nextIp, PASSWORD } from "./helpers.mjs";

const me = (srv, token) => call(srv, "GET", "/api/auth/me", { token });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST com o corpo em duas metades: devolve `{ finish, done }`. Entre o envio da
 * primeira metade e o `finish()` o servidor já recebeu os cabeçalhos (e o token),
 * mas ainda espera o corpo — é a janela em que outro pedido muda o estado.
 */
function splitPost(srv, path, token, body) {
  const payload = Buffer.from(JSON.stringify(body));
  const half = Math.floor(payload.length / 2);
  let req;
  const done = new Promise((ok, fail) => {
    req = request({
      host: "127.0.0.1", port: srv.port, method: "POST", path,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": payload.length,
      },
    }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = undefined; }
        ok({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", fail);
  });
  req.write(payload.subarray(0, half));
  return { finish: () => req.end(payload.subarray(half)), done };
}

describe("R. Condições de corrida", () => {
  let srv;
  before(async () => { srv = await startServer({ env: { IMERSA_SIGNUP_MAX_PER_HOUR: "1000" } }); });
  after(async () => { await srv.stop(); });

  it("R1 quando troco a senha e apago a conta ao mesmo tempo com a senha antiga, então só um dos dois tem efeito", async () => {
    const acc = await register(srv);
    const [chg, del] = await Promise.all([
      call(srv, "POST", "/api/auth/password", { token: acc.token, body: { current: PASSWORD, next: "nova-senha-789" } }),
      call(srv, "POST", "/api/auth/delete", { token: acc.token, body: { password: PASSWORD } }),
    ]);
    const oks = [chg, del].filter((r) => r.status === 200).length;
    assert.equal(oks, 1, `senha ${chg.status}, apagar ${del.status}`);
    const loser = chg.status === 200 ? del : chg;
    assert.ok([401, 403, 409].includes(loser.status), `perdedor: ${loser.status}`);
    const db = srv.db();
    try {
      const n = db.prepare("SELECT COUNT(*) n FROM users WHERE id=?").get(acc.user.id).n;
      assert.equal(n, del.status === 200 ? 0 : 1);
    } finally { db.close(); }
    if (chg.status === 200) assert.equal((await login(srv, acc.email, "nova-senha-789")).status, 200);
  });

  it("R2 quando encerro um aparelho enquanto o pedido de \"encerrar os outros\" dele ainda chega, então o pedido dele dá 401 e eu continuo conectado", async () => {
    const acc = await register(srv);
    const thief = (await login(srv, acc.email)).body;
    const pending = splitPost(srv, "/api/auth/sessions/revoke", thief.token, { others: true });
    await sleep(50);
    const r = await call(srv, "POST", "/api/auth/sessions/revoke", { token: acc.token, body: { id: thief.sessionId } });
    assert.equal(r.status, 200);
    pending.finish();
    assert.equal((await pending.done).status, 401);
    assert.equal((await me(srv, acc.token)).status, 200, "o dono não pode ser derrubado pelo aparelho que ele encerrou");
  });

  it("R3 quando encerro um aparelho enquanto a troca de senha dele ainda chega, então a troca dá 401 e a senha continua a mesma", async () => {
    const acc = await register(srv);
    const thief = (await login(srv, acc.email)).body;
    const pending = splitPost(srv, "/api/auth/password", thief.token, { current: PASSWORD, next: "do-ladrao-999" });
    await sleep(50);
    await call(srv, "POST", "/api/auth/sessions/revoke", { token: acc.token, body: { id: thief.sessionId } });
    pending.finish();
    assert.equal((await pending.done).status, 401);
    assert.equal((await me(srv, acc.token)).status, 200);
    assert.equal((await login(srv, acc.email, PASSWORD)).status, 200);
    assert.equal((await login(srv, acc.email, "do-ladrao-999")).status, 401);
  });

  it("R4 quando encerro um aparelho enquanto o \"apagar conta\" dele ainda chega, então o apagar dá 401 e a conta fica", async () => {
    const acc = await register(srv);
    const thief = (await login(srv, acc.email)).body;
    const pending = splitPost(srv, "/api/auth/delete", thief.token, { password: PASSWORD });
    await sleep(50);
    await call(srv, "POST", "/api/auth/sessions/revoke", { token: acc.token, body: { id: thief.sessionId } });
    pending.finish();
    assert.equal((await pending.done).status, 401);
    assert.equal((await me(srv, acc.token)).status, 200);
  });

  // A janela é o scrypt do login: ele leu o hash antigo e a troca grava a senha
  // nova antes de ele terminar. Os atrasos varrem essa janela; o que se confere é
  // sempre o mesmo — nenhum login com a senha antiga sobrevive à troca.
  it("R5 quando um login com a senha antiga cruza uma troca de senha, então a sessão dele nunca sobra viva", async () => {
    for (let delay = 0; delay <= 240; delay += 15) {
      const acc = await register(srv);
      const change = call(srv, "POST", "/api/auth/password", {
        token: acc.token, body: { current: PASSWORD, next: "trocada-4567" },
      });
      await sleep(delay);
      const lg = await login(srv, acc.email, PASSWORD, { ip: nextIp() });
      assert.equal((await change).status, 200);
      if (lg.status === 200) {
        assert.equal((await me(srv, lg.body.token)).status, 401,
          `atraso ${delay} ms: o login com a senha antiga ficou com sessão viva depois da troca`);
      } else {
        assert.equal(lg.status, 401, `atraso ${delay} ms: ${lg.status}`);
      }
    }
  });
});
