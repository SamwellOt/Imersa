// Ações no card (adiar, suspender, reiniciar) sobre um registro que já sumiu do
// banco — apagado por um tombstone que chegou da sincronização. A ação não pode
// ressuscitá-lo com `updatedAt` novo. Testes pela API pública (srs e sessão).
import { describe, it, expect, beforeEach, resetDb, setClock, at } from "../harness";
import { rec, putCards } from "../fixtures";
import { db } from "@/lib/db";
import { buryCard, suspendCard, forgetCard } from "@/lib/srs";
import { createReviewSession } from "@/lib/reviewSession";

const KEY = "ko-T1-01::w-가방";
const DAY = 86_400_000;
const T0 = at(2026, 10, 10, 12);

/** Card em revisão, vencido — o que a fila de revisão monta. */
const vencido = () =>
  rec({ key: KEY, state: 2, due: T0 - DAY, last_review: T0 - 4 * DAY, scheduled_days: 3, stability: 3, difficulty: 5, reps: 3 });

describe("ações no card apagado (sincronização)", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(T0);
  });

  it("adiar não ressuscita card apagado", async () => {
    const r = vencido();
    await putCards(r);
    await db.cards.delete(KEY); // o tombstone de outro aparelho chegou
    await buryCard(r);
    expect(await db.cards.get(KEY)).toBeUndefined();
  });

  it("suspender não ressuscita card apagado", async () => {
    const r = vencido();
    await putCards(r);
    await db.cards.delete(KEY);
    await suspendCard(r);
    expect(await db.cards.get(KEY)).toBeUndefined();
  });

  it("reiniciar não ressuscita card apagado", async () => {
    const r = vencido();
    await putCards(r);
    await db.cards.delete(KEY);
    await forgetCard(r);
    expect(await db.cards.get(KEY)).toBeUndefined();
  });

  it("controle: adiar um card que existe continua gravando o adiamento", async () => {
    const r = vencido();
    await putCards(r);
    await buryCard(r);
    expect((await db.cards.get(KEY))!.buriedUntil).toBeTruthy();
  });

  it("sessão: adiar um card apagado pelo sync não o recria", async () => {
    await putCards(vencido());
    const s = createReviewSession({ language: "ko" });
    await s.start();
    expect(s.getView().total).toBe(1);
    await db.cards.delete(KEY); // sumiu entre a montagem da fila e a ação
    await s.act("suspend");
    expect(await db.cards.get(KEY)).toBeUndefined();
  });
});
