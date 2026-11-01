// Sessão de revisão sem React (lib/reviewSession): testes pela própria interface
// que a tela usa — `getView()` e os comandos —, com IndexedDB real, a dose de
// fixture e relógio falso. Nada de chamar funções internas da fila.
import { describe, it, expect, beforeEach, resetDb, setClock, advanceClock, at, sleep, waitFor } from "../harness";
import { loadFixtureDose, saveSrs, rec, putCards } from "../fixtures";
import { createReviewSession, type ReviewSummary } from "@/lib/reviewSession";
import { db } from "@/lib/db";
import { Rating } from "ts-fsrs";
import { useApp } from "@/lib/store";

const DAY = 86_400_000;
const MIN = 60_000;
const T0 = at(2026, 10, 10, 12);
/** Card em revisão realista, vencido (ou não) em `due`. */
const review = (key: string, due: number) =>
  rec({ key, state: 2, due, last_review: due - 3 * DAY, scheduled_days: 3, stability: 3, difficulty: 5, reps: 3 });
/** Card em (re)aprendizado vencido em `due`. */
const learning = (key: string, due: number) =>
  rec({ key, state: 1, due, last_review: due - 10 * MIN, scheduled_days: 0, stability: 1, difficulty: 5, reps: 1, learning_steps: 1 });

describe("sessão de revisão: fila da dose", () => {
  beforeEach(async () => {
    await resetDb();
    useApp.setState({ autoPlayExample: false, flashcardExample: false, flashcardFrontText: true });
  });

  it("três Fácil fecham a sessão e chamam onDone com o resumo", async () => {
    const dose = await loadFixtureDose(1);
    const done: ReviewSummary[] = [];
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: (r) => void done.push(r) });
    await s.start();
    expect(s.getView().estado).toBe("card");
    expect(s.getView().faltam).toEqual({ new: 3, learning: 0, review: 0 });
    await s.grade(Rating.Easy, 0);
    await s.grade(Rating.Easy, 0);
    await s.grade(Rating.Easy, 0);
    const v = s.getView();
    expect(v.estado).toBe("fim");
    expect(v.fechado).toBe(true);
    expect(done).toEqual([{ reviewed: 3, newLearned: 3, again: 0 }]);
    expect(await db.reviewLog.count()).toBe(3);
  });

  it("subscribe avisa a tela a cada mudança da visão", async () => {
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    let calls = 0;
    const off = s.subscribe(() => void calls++);
    await s.start();
    const before = calls;
    await s.grade(Rating.Good, 0);
    off();
    expect(calls).toBeGreaterThan(before);
    expect(s.getView().resumo.reviewed).toBe(1);
  });

  it("«Já sei» tira o card sem nota e é desfazível", async () => {
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    await s.start();
    await s.known();
    expect(s.getView().faltam.new).toBe(2);
    expect(s.getView().resumo.reviewed).toBe(0);
    expect(await db.reviewLog.count()).toBe(0);
    await s.undo();
    expect(s.getView().faltam.new).toBe(3);
    expect(await db.cards.count()).toBe(0);
  });

  it("cota do dia estourada: estado cota e o fecho não acontece", async () => {
    const dose = await loadFixtureDose(1);
    await saveSrs({ newPerDay: 0 });
    let called = false;
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => void (called = true) });
    await s.start();
    const v = s.getView();
    expect(v.estado).toBe("cota");
    expect(v.heldBack).toBe(3);
    // nada fecha a dose sozinho: o fecho só vem de um comando explícito
    expect(called).toBe(false);
  });

  it("dose já revisada: fila vazia e close() chama onDone com zeros, uma vez só", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(...dose.cards.map((c) => review(`${dose.id}::${c.id}`, Date.now() + 5 * DAY)));
    let calls = 0;
    const done: ReviewSummary[] = [];
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: (r) => { calls++; done.push(r); } });
    await s.start();
    expect(s.getView().estado).toBe("fim");
    expect(s.getView().vazia).toBe(true);
    // dois toques seguidos: a trava do fecho deixa passar um só
    const a = s.close();
    const b = s.close();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(done).toEqual([{ reviewed: 0, newLearned: 0, again: 0 }]);
  });

  it("close() com onDone que falha mostra o erro e destrava o botão", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(...dose.cards.map((c) => review(`${dose.id}::${c.id}`, Date.now() + 5 * DAY)));
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => { throw new Error("gravação falhou"); } });
    await s.start();
    await s.close();
    const v = s.getView();
    expect(v.erroAoFechar).toBe("gravação falhou");
    expect(v.fechando).toBe(false);
  });

  it("falha ao gravar a nota: o card fica na tela com os botões vivos", async () => {
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    await s.start();
    const antes = s.getView().atual!;
    await db.close();
    await s.grade(Rating.Good, 0);
    const falhou = s.getView();
    expect(falhou.falha).toContain("Não deu para salvar a nota");
    expect(falhou.atual!.key).toBe(antes.key);
    expect(falhou.atual!.uid).toBeGreaterThan(antes.uid);
    expect(falhou.resumo.reviewed).toBe(0);
    await db.open();
    await s.grade(Rating.Good, 0);
    expect(s.getView().falha).toBe(null);
    expect(s.getView().resumo.reviewed).toBe(1);
  });

  it("desfazer duas vezes seguidas mexe nos dois cards certos", async () => {
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    await s.start();
    const primeiro = s.getView().atual!.key;
    await s.grade(Rating.Good, 0);
    const segundo = s.getView().atual!.key;
    // dois cliques no "Desfazer" antes de a primeira volta terminar
    await Promise.all([s.undo(), s.undo()]);
    const v = s.getView();
    expect(v.atual!.key).toBe(primeiro);
    expect(v.faltam.new).toBe(3);
    expect(v.podeDesfazer).toBe(false);
    expect(segundo !== primeiro).toBe(true);
    expect(await db.cards.count()).toBe(0);
    expect(await db.reviewLog.count()).toBe(0);
  });

  it("desfazer na tela de fim reabre a sessão no último card", async () => {
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    await s.start();
    await s.grade(Rating.Easy, 0);
    await s.grade(Rating.Easy, 0);
    const ultimo = s.getView().atual!.key;
    await s.grade(Rating.Easy, 0);
    expect(s.getView().fechado).toBe(true);
    await s.undo();
    const v = s.getView();
    expect(v.estado).toBe("card");
    expect(v.fechado).toBe(false);
    expect(v.atual!.key).toBe(ultimo);
  });

  it("nota sobre o registro fresco do banco, não sobre a cópia da fila", async () => {
    const past = Date.now() - DAY;
    await putCards(review("ko-T1-01::w-가방", past));
    const s = createReviewSession({ language: "ko" });
    await s.start();
    // outro aparelho sincronizou o card depois que a fila foi montada
    await db.cards.update("ko-T1-01::w-가방", { reps: 9 });
    await s.grade(Rating.Good, 0);
    expect((await db.cards.get("ko-T1-01::w-가방"))!.reps).toBe(10);
  });
});

describe("sessão de revisão: cards que voltam", () => {
  beforeEach(async () => {
    await resetDb();
    useApp.setState({ autoPlayExample: false, flashcardExample: false, flashcardFrontText: true });
  });

  it("De novo volta logo depois do card em tela quando vence", async () => {
    setClock(T0);
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    await s.start();
    const a = s.getView().atual!.key;
    await s.grade(Rating.Again, 0);
    const b = s.getView().atual!.key;
    expect(b !== a).toBe(true);
    // passou 1 min: o "De novo" do card A está vencido. Ele entra logo depois do
    // card que está em tela (o próximo), e não no lugar dele.
    advanceClock(MIN + 1000);
    await s.grade(Rating.Easy, 0);
    const c = s.getView().atual!.key;
    expect(c !== a && c !== b).toBe(true);
    await s.grade(Rating.Easy, 0);
    expect(s.getView().atual!.key).toBe(a);
  });

  it("learn-ahead: no fim da fila, o que vence em até 20 min entra de novo", async () => {
    setClock(T0);
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    await s.start();
    const a = s.getView().atual!.key;
    await s.grade(Rating.Again, 0);
    await s.grade(Rating.Easy, 0);
    await s.grade(Rating.Easy, 0);
    // sem mais nada a fazer, o "De novo" (vence em 1 min) entra adiantado
    const v = s.getView();
    expect(v.estado).toBe("card");
    expect(v.atual!.key).toBe(a);
    await s.grade(Rating.Easy, 0);
    expect(s.getView().estado).toBe("fim");
  });

  it("adiar o último card fecha a sessão como qualquer fim de fila", async () => {
    const past = Date.now() - DAY;
    await putCards(review("ko-T1-01::w-가방", past));
    const s = createReviewSession({ language: "ko" });
    await s.start();
    expect(s.getView().estado).toBe("card");
    await s.act("bury");
    const v = s.getView();
    expect(v.estado).toBe("fim");
    expect(v.vazia).toBe(false);
    expect((await db.cards.toArray()).filter((c) => c.buriedUntil).length).toBe(1);
  });
});

describe("sessão de revisão: nota não espera a rede; carga desmontada", () => {
  beforeEach(async () => {
    await resetDb();
    useApp.setState({ autoPlayExample: false, flashcardExample: false, flashcardFrontText: true });
  });

  it("a próxima nota sai mesmo com a busca de cards que voltam travada na rede", async () => {
    const past = Date.now() - DAY;
    await putCards(learning("ko-T1-01::w-가방", past - 2000), learning("ko-T1-01::w-나무", past - 1000));
    const s = createReviewSession({ language: "ko" });
    await s.start();
    expect(s.getView().total).toBe(2);
    // card de outra dose, ainda sem cache: resolvê-lo trava na rede
    await putCards(learning("ko-T1-02::w-travado", past));
    const realFetch = window.fetch;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).includes("T1-02")
        ? new Promise<Response>(() => {})
        : realFetch(input, init)) as typeof fetch;
    try {
      // a nota é gravada e a fila anda; a busca dos que voltam fica presa na rede
      void s.grade(Rating.Good, 0);
      await waitFor(() => s.getView().resumo.reviewed === 1, 1000, "nota gravada");
      expect(s.getView().atual!.key).toBe("ko-T1-01::w-나무");
      // o próximo comando (Desfazer) não espera a rede
      const outcome = await Promise.race([
        s.undo().then(() => "ok"),
        sleep(1500).then(() => "travou"),
      ]);
      expect(outcome).toBe("ok");
      expect(s.getView().resumo.reviewed).toBe(0);
    } finally {
      window.fetch = realFetch;
    }
  });

  it("carga de sessão desmontada não apaga card órfão", async () => {
    const past = Date.now() - DAY;
    await putCards(learning("ko-T1-01::w-sumiu", past));
    const s = createReviewSession({ language: "ko" });
    const load = s.start();
    s.dispose();
    await load;
    expect(await db.cards.get("ko-T1-01::w-sumiu")).toBeTruthy();
  });

  it("StrictMode (start, dispose, start): a fila sai uma vez, sem card repetido", async () => {
    const dose = await loadFixtureDose(1);
    const s = createReviewSession({ language: "ko", introduce: dose, onDone: () => {} });
    const a = s.start();
    s.dispose();
    const b = s.start();
    await Promise.all([a, b]);
    expect(s.getView().total).toBe(3);
    expect(s.getView().faltam).toEqual({ new: 3, learning: 0, review: 0 });
  });
});
