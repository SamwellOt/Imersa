// Caracterização da sessão de revisão (components/srs/ReviewSession.tsx).
import { describe, it, expect, beforeEach, afterEach, resetDb, findByText, queryByText, waitFor, press, textOf, sleep } from "../harness";
import { render, cleanup, click, settle } from "../render";
import { loadFixtureDose, saveSrs, rec, putCards } from "../fixtures";
import { ReviewSession, type ReviewSummary } from "@/components/srs/ReviewSession";
import { db } from "@/lib/db";
import { useApp } from "@/lib/store";

const DAY = 86_400_000;
/** Card em revisão realista. */
const review = (key: string, due: number) =>
  rec({ key, state: 2, due, last_review: due - 3 * DAY, scheduled_days: 3, stability: 3, difficulty: 5, reps: 3 });

const counts = (el: HTMLElement) =>
  ["novos", "aprendendo", "a revisar"].map((l) => textOf(el.querySelector(`[title="${l}"]`)));

async function reveal(el: HTMLElement) {
  click(await findByText(el, "Mostrar resposta", { selector: "button" }));
}
async function gradeBtn(el: HTMLElement, label: string) {
  return findByText(el, label, { selector: "button", partial: true });
}
const feitos = (el: HTMLElement) => Number(/(\d+) feitos/.exec(textOf(el))?.[1] ?? -1);
/** Revela e dá a nota; espera o contador de feitos subir (ou a sessão acabar). */
async function grade(el: HTMLElement, label: string) {
  await reveal(el);
  const before = feitos(el);
  click(await gradeBtn(el, label));
  await waitFor(() => feitos(el) > before || textOf(el).includes("Revisão concluída") || textOf(el).includes("Conferindo"), 4000, "nota gravada");
  await settle(100);
}

describe("ReviewSession", () => {
  beforeEach(async () => {
    await resetDb();
    // sem áudio automático (a fixture não tem TTS)
    useApp.setState({ autoPlayExample: false, flashcardExample: false, flashcardFrontText: true });
  });
  afterEach(() => cleanup());

  it("dose nova: contadores, três Fácil, onDone com o resumo", async () => {
    const dose = await loadFixtureDose(1);
    const done: ReviewSummary[] = [];
    const el = render(<ReviewSession language="ko" introduce={dose} onDone={(s) => void done.push(s)} />);
    await findByText(el, "Mostrar resposta", { selector: "button" });
    expect(counts(el)).toEqual(["3 novos", "0 aprendendo", "0 a revisar"]);
    await grade(el, "Fácil");
    expect(counts(el)).toEqual(["2 novos", "0 aprendendo", "0 a revisar"]);
    expect(textOf(el)).toContain("1 feitos");
    await grade(el, "Fácil");
    await grade(el, "Fácil");
    await findByText(el, "Revisão concluída");
    await waitFor(() => done.length === 1, 3000, "onDone");
    expect(done).toEqual([{ reviewed: 3, newLearned: 3, again: 0 }]);
    expect(textOf(el)).toContain("3 cards revisados · 3 palavras novas");
    expect(await db.cards.count()).toBe(3);
    expect(await db.reviewLog.count()).toBe(3);
  });

  it("De novo: o card volta no fim (learn-ahead) e conta como esquecido", async () => {
    const dose = await loadFixtureDose(1);
    const done: ReviewSummary[] = [];
    const el = render(<ReviewSession language="ko" introduce={dose} onDone={(s) => void done.push(s)} />);
    await grade(el, "De novo");
    expect(counts(el)).toEqual(["2 novos", "0 aprendendo", "0 a revisar"]);
    await grade(el, "Fácil");
    await grade(el, "Fácil");
    await waitFor(() => counts(el)[1] === "1 aprendendo", 3000, "card de volta");
    expect(counts(el)).toEqual(["0 novos", "1 aprendendo", "0 a revisar"]);
    await grade(el, "Fácil");
    await waitFor(() => done.length === 1, 3000, "onDone");
    expect(done).toEqual([{ reviewed: 4, newLearned: 3, again: 1 }]);
    expect(textOf(el)).toContain("4 cards revisados · 3 palavras novas · 1 esquecido");
  });

  it("Desfazer (botão e Z) reverte a nota e o card volta como novo", async () => {
    const dose = await loadFixtureDose(1);
    const el = render(<ReviewSession language="ko" introduce={dose} onDone={() => {}} />);
    await grade(el, "Bom");
    expect(await db.cards.count()).toBe(1);
    click(await findByText(el, "Desfazer", { selector: "button" }));
    await waitFor(() => counts(el)[0] === "3 novos", 3000, "desfeito");
    expect(await db.cards.count()).toBe(0);
    expect(textOf(el)).toContain("0 feitos");
    expect(queryByText(el, "Desfazer", { selector: "button" })).toBeNull();
    await grade(el, "Bom");
    press("z");
    await waitFor(() => counts(el)[0] === "3 novos", 3000, "desfeito com Z");
    expect(await db.reviewLog.count()).toBe(0);
  });

  it("«Já sei» (K) tira o card sem nota e é desfazível", async () => {
    const dose = await loadFixtureDose(1);
    const el = render(<ReviewSession language="ko" introduce={dose} onDone={() => {}} />);
    await findByText(el, "Mostrar resposta", { selector: "button" });
    press("k");
    await waitFor(() => counts(el)[0] === "2 novos", 3000, "já sei");
    expect((await db.cards.toArray()).map((c) => [c.cardId, c.known])).toEqual([["w-가방", true]]);
    expect(await db.reviewLog.count()).toBe(0);
    expect(textOf(el)).toContain("0 feitos");
    press("z");
    await waitFor(() => counts(el)[0] === "3 novos", 3000, "desfeito");
    expect(await db.cards.count()).toBe(0);
  });

  it("cota do dia estourada: aviso, sem Concluir", async () => {
    const dose = await loadFixtureDose(1);
    await saveSrs({ newPerDay: 0 });
    let called = false;
    const el = render(<ReviewSession language="ko" introduce={dose} onDone={() => void (called = true)} />);
    await findByText(el, "Você já fez suas palavras novas de hoje");
    expect(textOf(el)).toContain("Faltam 3 palavras desta dose.");
    expect(queryByText(el, "Concluir", { selector: "button" })).toBeNull();
    await sleep(200);
    expect(called).toBe(false);
  });

  it("dose já revisada: mensagem e Concluir chama onDone com zeros", async () => {
    const dose = await loadFixtureDose(1);
    const later = Date.now() + 5 * DAY;
    await putCards(...dose.cards.map((c) => review(`${dose.id}::${c.id}`, later)));
    const done: ReviewSummary[] = [];
    const el = render(<ReviewSession language="ko" introduce={dose} onDone={(s) => void done.push(s)} />);
    await findByText(el, "Cards desta dose já revisados hoje");
    click(await findByText(el, "Concluir", { selector: "button" }));
    expect(done).toEqual([{ reviewed: 0, newLearned: 0, again: 0 }]);
  });

  it("avulsa vazia: Nada para revisar agora, com dica customizável", async () => {
    let el = render(<ReviewSession language="ko" />);
    await findByText(el, "Nada para revisar agora");
    expect(textOf(el)).toContain("Você está em dia.");
    el = render(<ReviewSession language="ko" emptyHint="Dica X" />);
    await findByText(el, "Dica X");
  });

  it("avulsa: órfão só sai quando a dose/card sumiu de verdade (com tombstone)", async () => {
    const past = Date.now() - DAY;
    await putCards(
      review("ko-T1-01::w-가방", past),
      review("ko-T1-01::w-zzz", past), // card sumiu do dose.json
      review("ko-T1-03::w-x", past), // no curso, mas dose.json 404
      review("ko-T1-99::w-x", past), // fora do course.json
    );
    const el = render(<ReviewSession language="ko" />);
    await findByText(el, "Mostrar resposta", { selector: "button" });
    expect(counts(el)).toEqual(["0 novos", "0 aprendendo", "1 a revisar"]);
    expect((await db.cards.toArray()).map((c) => c.key)).toEqual(["ko-T1-01::w-가방"]);
    expect((await db.tombstones.toArray()).map((t) => t.tid).sort()).toEqual([
      "card:ko-T1-01::w-zzz", "card:ko-T1-03::w-x", "card:ko-T1-99::w-x",
    ]);
  });

  it("avulsa: adiar (-) tira o card da sessão", async () => {
    const past = Date.now() - DAY;
    await putCards(review("ko-T1-01::w-가방", past), review("ko-T1-01::w-나무", past - 1000));
    const el = render(<ReviewSession language="ko" />);
    await findByText(el, "Mostrar resposta", { selector: "button" });
    expect(counts(el)[2]).toBe("2 a revisar");
    press("-");
    await waitFor(() => counts(el)[2] === "1 a revisar", 3000, "adiado");
    const buried = (await db.cards.toArray()).filter((c) => c.buriedUntil);
    expect(buried.length).toBe(1);
    press("@");
    // o último card saiu da fila: a sessão fecha como qualquer fim de fila
    await findByText(el, "Revisão concluída");
    expect(queryByText(el, "Nada para revisar agora")).toBeNull();
    expect((await db.cards.toArray()).filter((c) => c.suspended).length).toBe(1);
  });

  it("dose: Concluir da fila vazia não chama onDone duas vezes", async () => {
    const dose = await loadFixtureDose(1);
    const later = Date.now() + 5 * DAY;
    await putCards(...dose.cards.map((c) => review(`${dose.id}::${c.id}`, later)));
    let calls = 0;
    const el = render(
      <ReviewSession language="ko" introduce={dose} onDone={() => { calls++; return sleep(200); }} />,
    );
    const btn = await findByText(el, "Concluir", { selector: "button" });
    click(btn);
    click(btn);
    await settle(20);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    await sleep(300);
    expect(calls).toBe(1);
  });

  it("card em revisão sem last_review abre e revela sem quebrar", async () => {
    const past = Date.now() - DAY;
    await putCards(rec({ key: "ko-T1-01::w-가방", state: 2, due: past, scheduled_days: 3, stability: 3, difficulty: 5, reps: 3 }));
    const el = render(<ReviewSession language="ko" />);
    await findByText(el, "Mostrar resposta", { selector: "button" });
    await grade(el, "Bom");
    await findByText(el, "Revisão concluída");
    const r = (await db.cards.toArray())[0];
    expect(r.reps).toBe(4);
    expect(typeof r.last_review).toBe("number");
  });
});
