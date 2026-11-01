// Caracterização de lib/srs.ts — o comportamento de HOJE (10/2026), para a
// divisão em camadas (srsCore / srsQueue / srsRepo) não mudar nada.
import { describe, it, expect, beforeEach, resetDb, setClock, advanceClock, at, seedRandom } from "../harness";
import { loadFixtureDose, saveSrs, rec, putCards, strip } from "../fixtures";
import { db, type CardRecord } from "@/lib/db";
import { nextDayStart, dayKey } from "@/lib/utils";
import * as srs from "@/lib/srs";
import { toFsrs } from "@/lib/srsCore";
import {
  parseSteps, stepsToText, sanitizeW, getSrsSettings, DEFAULT_SRS_SETTINGS, cardKey, isActive,
  isLearningState, humanInterval, humanDays, buildDoseQueue, buildDueQueue, gradeNew, gradeCard,
  undoGrade, getTodayCounts, markKnown, unmarkKnown, listKnown, addExtraCard, buryCard, suspendCard,
  countSuspended, unsuspendAll, forgetCard, rescheduleAll, countDue, countDueElsewhere, mostOverdue,
  countLearnAhead, countNewReady, dueLearning, nextDueAt, previewIntervals, previewNewIntervals,
  cardInfo, logImmersion, findSentenceCard, scheduler, RATINGS, MAX_ANSWER_MS, FSRS_PARAM_COUNT,
  MIN_REVIEWS_TO_OPTIMIZE, FSRS_DEFAULT_W,
} from "@/lib/srs";

const NOW = at(2026, 10, 10, 12);
const MIN = 60_000;
const DAY = 86_400_000;
const keysOf = (q: { key: string }[]) => q.map((e) => e.key);

describe("srs: API pública", () => {
  it("exporta os mesmos nomes", () => {
    expect(Object.keys(srs).sort()).toMatchSnapshot("exports");
  });
  it("constantes", () => {
    expect({ RATINGS, MAX_ANSWER_MS, FSRS_PARAM_COUNT, MIN_REVIEWS_TO_OPTIMIZE, w: FSRS_DEFAULT_W.length, DEFAULT_SRS_SETTINGS })
      .toMatchSnapshot("constantes");
  });
});

describe("srs: funções puras", () => {
  it("parseSteps / stepsToText", () => {
    expect(parseSteps("1m 10m")).toEqual(["1m", "10m"]);
    expect(parseSteps(" 1m,10m , 1d ")).toEqual(["1m", "10m", "1d"]);
    expect(parseSteps("1.5h")).toEqual(["1.5h"]);
    expect(parseSteps("")).toEqual([]);
    expect(parseSteps("1m 10x")).toBeNull();
    expect(parseSteps("10")).toBeNull();
    expect(stepsToText(["1m", "10m"])).toBe("1m 10m");
  });
  it("sanitizeW", () => {
    expect(sanitizeW(null)).toBeNull();
    expect(sanitizeW([1, 2])).toBeNull();
    expect(sanitizeW(Array(17).fill("1"))).toEqual(Array(17).fill(1));
    expect(sanitizeW(Array(19).fill(0.5))).toEqual(Array(19).fill(0.5));
    expect(sanitizeW(Array(21).fill(2))).toEqual(Array(21).fill(2));
    expect(sanitizeW([...Array(20).fill(1), NaN])).toBeNull();
    expect(sanitizeW([...Array(20).fill(1), "x"])).toBeNull();
  });
  it("humanInterval / humanDays", () => {
    const t = (ms: number) => humanInterval(0, ms);
    expect([t(-5), t(30_000), t(MIN), t(59.4 * MIN), t(60 * MIN), t(23.4 * 60 * MIN), t(DAY), t(29 * DAY), t(30 * DAY), t(45 * DAY), t(359 * DAY), t(365 * DAY), t(800 * DAY)])
      .toEqual(["<1 min", "<1 min", "1 min", "59 min", "1 h", "23 h", "1 d", "29 d", "1 mês", "2 meses", "12 meses", "1.0 a", "2.2 a"]);
    expect([humanDays(-3), humanDays(0), humanDays(1), humanDays(12), humanDays(90)]).toEqual(["<1 min", "<1 min", "1 d", "12 d", "3 meses"]);
  });
  it("cardKey, isActive, isLearningState", () => {
    expect(cardKey("ko-T1-01", "w-a")).toBe("ko-T1-01::w-a");
    const base = rec({ key: "d::w-a" });
    expect(isActive(base, 1000)).toBe(true);
    expect(isActive({ ...base, known: true }, 1000)).toBe(false);
    expect(isActive({ ...base, suspended: true }, 1000)).toBe(false);
    expect(isActive({ ...base, buriedUntil: 2000 }, 1000)).toBe(false);
    expect(isActive({ ...base, buriedUntil: 1000 }, 1000)).toBe(true);
    expect([0, 1, 2, 3].map((state) => isLearningState({ ...base, state }))).toEqual([false, true, false, true]);
  });
  it("findSentenceCard acha palavra e frase", async () => {
    const dose = await loadFixtureDose(1);
    expect(findSentenceCard(dose, "w-나무")?.target).toBe("나무");
    expect(findSentenceCard(dose, "s-1")?.target).toBe("나무 둘");
    expect(findSentenceCard(dose, "w-x")).toBeUndefined();
  });
});

describe("srs: ajustes", () => {
  beforeEach(async () => {
    await resetDb();
  });
  it("sem nada gravado = padrões", async () => {
    expect(await getSrsSettings()).toEqual(DEFAULT_SRS_SETTINGS);
  });
  it("valores inválidos voltam ao padrão, válidos ficam", async () => {
    await saveSrs({
      learningSteps: ["1m", "bad"], relearningSteps: ["5m"], w: [1, 2] as number[], maximumInterval: 0,
      learnAheadMin: -1, requestRetention: 1.2, newPerDay: 7,
    });
    expect(await getSrsSettings()).toMatchSnapshot("normalizado");
    await saveSrs({ requestRetention: 0.5, learnAheadMin: 0, maximumInterval: 1 });
    const s = await getSrsSettings();
    expect([s.requestRetention, s.learnAheadMin, s.maximumInterval]).toEqual([0.9, 0, 1]);
  });
});

describe("srs: fila da dose", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
    seedRandom(7);
  });
  it("dose nova: os 3 cards em ordem, sem cota retida", async () => {
    const dose = await loadFixtureDose(1);
    const q = await buildDoseQueue(dose);
    expect(q).toMatchSnapshot("fila");
    expect(q.heldBack).toBe(0);
  });
  it("teto diário corta e conta o que ficou de fora", async () => {
    const dose = await loadFixtureDose(1);
    await saveSrs({ newPerDay: 2 });
    const q = await buildDoseQueue(dose);
    expect(keysOf(q.entries)).toEqual(["ko-T1-01::w-가방", "ko-T1-01::w-나무"]);
    expect(q.heldBack).toBe(1);
    await saveSrs({ newPerDay: 0 });
    const z = await buildDoseQueue(dose);
    expect([z.entries.length, z.heldBack]).toEqual([0, 3]);
  });
  it("notas de hoje consomem a cota; card extra e de frase não", async () => {
    const dose = await loadFixtureDose(1);
    const dose2 = await loadFixtureDose(2);
    await saveSrs({ newPerDay: 2 });
    await gradeNew(dose2, dose2.cards[1], 3, 1000); // 라면: estreia, conta
    await addExtraCard(dose2, { ...dose2.cards[0], id: "w-extra" });
    const extra = await db.cards.get("ko-T1-02::w-extra");
    await gradeCard(extra!, 3, 1000); // nota em card extra: não conta
    expect((await getTodayCounts("ko")).newIntroduced).toBe(1);
    const q = await buildDoseQueue(dose);
    expect([keysOf(q.entries), q.heldBack]).toEqual([["ko-T1-01::w-가방"], 2]);
  });
  it("palavra com registro em outra dose não volta como nova", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(rec({ key: "ko-T1-02::w-가방", state: 2, due: NOW + 5 * DAY }));
    const q = await buildDoseQueue(dose);
    expect(keysOf(q.entries)).toEqual(["ko-T1-01::w-나무", "ko-T1-01::w-다리"]);
    expect(q.heldBack).toBe(0);
  });
  it("vencidos de outra dose ficam fora; os desta entram (aprendendo antes)", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(
      rec({ key: "ko-T1-01::w-가방", state: 2, due: NOW - DAY, scheduled_days: 3, stability: 3, difficulty: 5, reps: 3 }),
      rec({ key: "ko-T1-01::w-나무", state: 1, due: NOW - MIN, reps: 1 }),
      rec({ key: "ko-T1-02::w-라면", state: 2, due: NOW - DAY }),
    );
    const q = await buildDoseQueue(dose);
    expect(q).toMatchSnapshot("fila");
  });
  it("ordem dos novos: mix / before / after", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(
      rec({ key: "ko-T1-01::w-가방", state: 2, due: NOW - 2 * DAY, scheduled_days: 3, stability: 3, difficulty: 5, reps: 3 }),
    );
    // dois "vencidos" a mais nesta dose: cards fora do dose.json também contam como registro
    await putCards(
      rec({ key: "ko-T1-01::w-x1", state: 2, due: NOW - DAY, scheduled_days: 2, stability: 2, difficulty: 5, reps: 2 }),
      rec({ key: "ko-T1-01::w-x2", state: 2, due: NOW - 3 * DAY, scheduled_days: 2, stability: 2, difficulty: 5, reps: 2 }),
    );
    const out: Record<string, string[]> = {};
    for (const newOrder of ["mix", "before", "after"] as const) {
      await saveSrs({ newOrder });
      seedRandom(3);
      out[newOrder] = (await buildDoseQueue(dose)).entries.map((e) => `${e.isNew ? "N" : "R"}:${e.cardId}`);
    }
    expect(out).toMatchSnapshot("ordens");
  });
  it("reviewOrder retrievability / random", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(
      rec({ key: "ko-T1-01::w-x1", state: 2, due: NOW - DAY, last_review: NOW - 4 * DAY, scheduled_days: 3, stability: 3, difficulty: 5, reps: 2 }),
      rec({ key: "ko-T1-01::w-x2", state: 2, due: NOW - DAY, last_review: NOW - 30 * DAY, scheduled_days: 29, stability: 40, difficulty: 5, reps: 5 }),
      rec({ key: "ko-T1-01::w-x3", state: 2, due: NOW - DAY, last_review: NOW - 20 * DAY, scheduled_days: 19, stability: 2, difficulty: 5, reps: 5 }),
    );
    const out: Record<string, string[]> = {};
    for (const reviewOrder of ["retrievability", "random", "due"] as const) {
      await saveSrs({ reviewOrder, newOrder: "after" });
      seedRandom(11);
      out[reviewOrder] = (await buildDoseQueue(dose)).entries.filter((e) => !e.isNew).map((e) => e.cardId);
    }
    expect(out).toMatchSnapshot("ordens");
  });
  it("frase i+1: só com a opção ligada e a palavra em estudo (não «já sei»)", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(rec({ key: "ko-T1-02::w-가방", state: 1, due: NOW + 10 * MIN }));
    expect(keysOf((await buildDoseQueue(dose)).entries)).notToContain("ko-T1-01::s-1");
    await saveSrs({ sentenceCards: true });
    expect(keysOf((await buildDoseQueue(dose)).entries)).toContain("ko-T1-01::s-1");
    await putCards(rec({ key: "ko-T1-02::w-가방", state: 1, due: NOW + 10 * MIN, known: true }));
    expect(keysOf((await buildDoseQueue(dose)).entries)).notToContain("ko-T1-01::s-1");
  });
  it("learn-ahead: sem nada vencido nem novo, aprendendo em até 20 min entra", async () => {
    const dose = await loadFixtureDose(1);
    for (const c of dose.cards) await putCards(rec({ key: cardKey(dose.id, c.id), state: 2, due: NOW + 3 * DAY }));
    await putCards(rec({ key: "ko-T1-01::w-x1", state: 1, due: NOW + 15 * MIN }));
    await putCards(rec({ key: "ko-T1-01::w-x2", state: 3, due: NOW + 25 * MIN }));
    expect(keysOf((await buildDoseQueue(dose)).entries)).toEqual(["ko-T1-01::w-x1"]);
    await saveSrs({ learnAheadMin: 0 });
    expect((await buildDoseQueue(dose)).entries).toEqual([]);
  });
  it("adiado, suspenso, «já sei» e frase escondida ficam fora", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(
      rec({ key: "ko-T1-01::w-가방", state: 2, due: NOW - DAY, buriedUntil: NOW + DAY }),
      rec({ key: "ko-T1-01::w-나무", state: 2, due: NOW - DAY, suspended: true }),
      rec({ key: "ko-T1-01::w-다리", state: 2, due: NOW - DAY, known: true }),
      rec({ key: "ko-T1-01::s-1", state: 2, due: NOW - DAY, origin: "sentence" }),
    );
    expect((await buildDoseQueue(dose)).entries).toEqual([]);
  });
});

describe("srs: revisão avulsa", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
    seedRandom(5);
  });
  it("aprendendo sempre; revisões vencidas até o teto do dia, pelo vencimento", async () => {
    await saveSrs({ maxReviewsPerDay: 2 });
    await putCards(
      rec({ key: "a::w-1", state: 2, due: NOW - 1 * DAY }),
      rec({ key: "a::w-2", state: 2, due: NOW - 3 * DAY }),
      rec({ key: "b::w-3", state: 2, due: NOW - 2 * DAY }),
      rec({ key: "b::w-4", state: 1, due: NOW - 5 * MIN }),
      rec({ key: "b::w-5", state: 2, due: NOW + DAY }),
      rec({ key: "b::w-6", state: 1, due: NOW + 2 * MIN }),
      rec({ key: "x::w-7", state: 2, due: NOW - DAY, language: "ja" }),
    );
    const q = await buildDueQueue("ko");
    expect(keysOf(q)).toMatchSnapshot("fila");
    expect(q.every((e) => !e.isNew)).toBe(true);
  });
  it("o teto desconta notas de hoje em cards em revisão (aprendizado não)", async () => {
    await saveSrs({ maxReviewsPerDay: 2 });
    await putCards(
      rec({ key: "a::w-1", state: 2, due: NOW - DAY, scheduled_days: 2, stability: 2, difficulty: 5, reps: 2, last_review: NOW - 3 * DAY }),
      rec({ key: "a::w-2", state: 2, due: NOW - DAY }),
      rec({ key: "a::w-3", state: 2, due: NOW - DAY }),
      rec({ key: "a::w-9", state: 1, due: NOW - DAY, learning_steps: 1, reps: 1, last_review: NOW - DAY }),
    );
    await gradeCard((await db.cards.get("a::w-1"))!, 3, 1000);
    await gradeCard((await db.cards.get("a::w-9"))!, 3, 1000);
    expect(await getTodayCounts("ko")).toEqual({ reviewsDone: 2, newIntroduced: 0, reviewCardsDone: 1 });
    expect((await buildDueQueue("ko")).filter((e) => e.rec!.state === 2).length).toBe(1);
  });
  it("learn-ahead quando não há nada vencido", async () => {
    await putCards(rec({ key: "a::w-1", state: 1, due: NOW + 10 * MIN }), rec({ key: "a::w-2", state: 1, due: NOW + 30 * MIN }));
    expect(keysOf(await buildDueQueue("ko"))).toEqual(["a::w-1"]);
  });
});

describe("srs: contadores e consultas", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
  });
  it("countDue, countDueElsewhere, mostOverdue, countLearnAhead, countSuspended, nextDueAt", async () => {
    await putCards(
      rec({ key: "a::w-1", state: 2, due: NOW - DAY }),
      rec({ key: "a::w-2", state: 2, due: NOW - 3 * DAY }),
      rec({ key: "b::w-3", state: 1, due: NOW - MIN }),
      rec({ key: "b::w-4", state: 1, due: NOW + 10 * MIN }),
      rec({ key: "b::w-5", state: 1, due: NOW + 40 * MIN }),
      rec({ key: "b::w-6", state: 2, due: NOW - DAY, suspended: true }),
      rec({ key: "b::w-7", state: 2, due: NOW - DAY, buriedUntil: NOW + 5 * MIN }),
      rec({ key: "b::w-8", state: 2, due: NOW - DAY, known: true }),
    );
    expect({
      due: await countDue("ko"),
      elsewhereA: await countDueElsewhere("ko", "a"),
      overdue: (await mostOverdue("ko"))?.key,
      ahead: await countLearnAhead("ko"),
      suspended: await countSuspended("ko"),
      next: (await nextDueAt("ko"))! - NOW,
    }).toEqual({ due: 3, elsewhereA: 1, overdue: "a::w-2", ahead: 1, suspended: 1, next: 5 * MIN });
    expect(await mostOverdue("ja")).toBeNull();
    expect(await nextDueAt("ja")).toBeNull();
  });
  it("countNewReady: só os 20 da dose contam como vistos, limitado pela cota", async () => {
    await putCards(rec({ key: "d::w-1" }), rec({ key: "d::w-2", origin: "extra" }));
    expect(await countNewReady("d", "ko", 3)).toBe(2);
    await saveSrs({ newPerDay: 1 });
    expect(await countNewReady("d", "ko", 3)).toBe(1);
    expect(await countNewReady("d", "ko", 1)).toBe(0);
  });
  it("dueLearning: escopo da dose ou do idioma, com antecedência", async () => {
    await putCards(
      rec({ key: "a::w-1", state: 1, due: NOW - MIN }),
      rec({ key: "a::w-2", state: 3, due: NOW + 5 * MIN }),
      rec({ key: "b::w-3", state: 1, due: NOW - 2 * MIN }),
      rec({ key: "b::w-4", state: 2, due: NOW - DAY }),
      rec({ key: "a::s-1", state: 1, due: NOW - MIN, origin: "sentence" }),
    );
    expect(keysOf(await dueLearning({ language: "ko", doseId: "a" }))).toEqual(["a::w-1"]);
    expect(keysOf(await dueLearning({ language: "ko", doseId: "a" }, 10))).toEqual(["a::w-1", "a::w-2"]);
    expect(keysOf(await dueLearning({ language: "ko" }))).toEqual(["b::w-3", "a::w-1"]);
    await saveSrs({ sentenceCards: true });
    expect(keysOf(await dueLearning({ language: "ko", doseId: "a" }))).toEqual(["a::s-1", "a::w-1"]);
  });
  it("logImmersion grava evento (e ignora ≤ 0)", async () => {
    await logImmersion("ko", 0);
    await logImmersion("ko", 1500, "ko-T1-01");
    await logImmersion("ko", 700);
    const rows = (await db.immersionLog.toArray()).sort((a, b) => b.ms - a.ms);
    expect(rows.map(({ uid: _u, ...r }) => r)).toEqual([
      { language: "ko", day: dayKey(new Date(NOW)), ms: 1500, at: NOW, doseId: "ko-T1-01" },
      { language: "ko", day: dayKey(new Date(NOW)), ms: 700, at: NOW },
    ]);
  });
});

describe("srs: notas", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
  });
  it("gradeNew cria o registro e o log, para cada nota", async () => {
    const dose = await loadFixtureDose(1);
    const out: Record<string, unknown> = {};
    for (const r of RATINGS) {
      await resetDb();
      const g = await gradeNew(dose, dose.cards[0], r, 99_999);
      const log = await db.reviewLog.toArray();
      out[r] = { g: { ...g, rec: strip(g.rec) }, due: g.rec.due - NOW, log };
    }
    expect(out).toMatchSnapshot("notas");
  });
  it("gradeNew de card de frase marca origin", async () => {
    const dose = await loadFixtureDose(1);
    const g = await gradeNew(dose, dose.sentenceCards![0], 3, 10);
    expect([g.rec.origin, (await db.reviewLog.toArray())[0].origin]).toEqual(["sentence", "sentence"]);
    expect((await getTodayCounts("ko")).newIntroduced).toBe(0);
  });
  it("gradeNew sobre registro já existente vira revisão (não estreia)", async () => {
    const dose = await loadFixtureDose(1);
    const first = await gradeNew(dose, dose.cards[0], 3, 10);
    advanceClock(11 * MIN);
    const again = await gradeNew(dose, dose.cards[0], 3, 10);
    expect([again.wasNew, strip(again.prev), again.rec.state]).toEqual([false, strip(first.rec), 2]);
    expect((await getTodayCounts("ko")).newIntroduced).toBe(1);
  });
  it("sequência Good→Good→Good: vence no início do dia de estudo", async () => {
    const dose = await loadFixtureDose(1);
    let g = await gradeNew(dose, dose.cards[0], 3, 10);
    const trail: unknown[] = [{ state: g.rec.state, due: g.rec.due - NOW }];
    advanceClock(10 * MIN);
    g = await gradeCard(g.rec, 3, 10);
    trail.push({ state: g.rec.state, due: g.rec.due - NOW, sched: g.rec.scheduled_days });
    expect(new Date(g.rec.due).getHours()).toBe(4);
    advanceClock(g.rec.due - Date.now() + 6 * 3600_000);
    g = await gradeCard(g.rec, 3, 10);
    trail.push({ state: g.rec.state, due: g.rec.due - NOW, sched: g.rec.scheduled_days, elapsed: g.rec.elapsed_days });
    expect(new Date(g.rec.due).getHours()).toBe(4);
    expect(trail).toMatchSnapshot("trilha");
  });
  it("gradeCard usa o registro FRESCO do banco, não o do chamador", async () => {
    const dose = await loadFixtureDose(1);
    const g1 = await gradeNew(dose, dose.cards[0], 3, 10);
    advanceClock(10 * MIN);
    await gradeCard(g1.rec, 3, 10); // gradua
    advanceClock(MIN);
    const g3 = await gradeCard(g1.rec, 1, 10); // g1.rec é velho
    expect(g3.prev!.state).toBe(2);
    expect(g3.rec.state).toBe(3);
    expect(g3.rec.lapses).toBe(1);
  });
  it("nota remove buriedUntil", async () => {
    await putCards(rec({ key: "a::w-1", state: 1, buriedUntil: NOW + DAY }));
    const g = await gradeCard((await db.cards.get("a::w-1"))!, 3, 10);
    expect("buriedUntil" in g.rec).toBe(false);
  });
  it("undoGrade: card que nasceu na nota some (com tombstones)", async () => {
    const dose = await loadFixtureDose(1);
    const g = await gradeNew(dose, dose.cards[0], 3, 10);
    advanceClock(5000);
    await undoGrade(g);
    expect(await db.cards.count()).toBe(0);
    expect(await db.reviewLog.count()).toBe(0);
    expect((await db.tombstones.toArray()).map((t) => [t.kind, t.id === g.reviewUid || t.id]).sort()).toEqual([
      ["card", "ko-T1-01::w-가방"], ["review", true],
    ]);
    expect(await getTodayCounts("ko")).toEqual({ reviewsDone: 0, newIntroduced: 0, reviewCardsDone: 0 });
  });
  it("undoGrade: card que já existia volta ao estado anterior com updatedAt novo", async () => {
    const dose = await loadFixtureDose(1);
    const g1 = await gradeNew(dose, dose.cards[0], 3, 10);
    advanceClock(10 * MIN);
    const g2 = await gradeCard(g1.rec, 4, 10);
    advanceClock(5000);
    await undoGrade(g2);
    const back = await db.cards.get(g1.rec.key);
    expect(strip(back)).toEqual(strip(g1.rec));
    expect(back!.updatedAt).toBe(Date.now());
    expect(await db.reviewLog.count()).toBe(1);
  });
  it("previews de intervalo (novo e em revisão)", async () => {
    const r = rec({ key: "a::w-1", state: 2, due: NOW, last_review: NOW - 5 * DAY, scheduled_days: 5, stability: 5, difficulty: 5, reps: 4 });
    const lbl = (p: Record<number, { label: string }>) => RATINGS.map((x) => p[x].label);
    expect({ novo: lbl(await previewNewIntervals()), rev: lbl(await previewIntervals(r)) }).toMatchSnapshot("rótulos");
  });
  it("cardInfo", () => {
    const r = rec({ key: "a::w-1", state: 2, due: NOW, last_review: NOW - 5 * DAY, scheduled_days: 5, stability: 5, difficulty: 6, reps: 4, lapses: 1 });
    const info = cardInfo(r, DEFAULT_SRS_SETTINGS, NOW);
    expect({ ...info, retrievability: +info.retrievability.toFixed(4) }).toMatchSnapshot("info");
    expect(cardInfo({ ...r, state: 0 }, DEFAULT_SRS_SETTINGS, NOW).retrievability).toBe(0);
  });
  it("cardInfo sem last_review estima pela data de vencimento − intervalo", () => {
    const r = rec({ key: "a::w-1", state: 2, due: NOW, last_review: NOW - 5 * DAY, scheduled_days: 5, stability: 5, difficulty: 6, reps: 4 });
    const { last_review: _l, ...noLast } = r;
    const a = cardInfo(r, DEFAULT_SRS_SETTINGS, NOW).retrievability;
    const b = cardInfo(noLast as typeof r, DEFAULT_SRS_SETTINGS, NOW).retrievability;
    expect(b).toBe(a);
    expect(toFsrs({ ...rec({ key: "a::w-1" }), state: 0 }).last_review).toBeUndefined();
  });
  it("toFsrs: last_review = 0 é uma data, não ausência", () => {
    const r = rec({ key: "a::w-1", state: 1, due: NOW, last_review: 0, scheduled_days: 0 });
    expect(toFsrs(r).last_review!.getTime()).toBe(0);
  });
  it("scheduler respeita w customizado", () => {
    const w = [...FSRS_DEFAULT_W];
    expect(scheduler({ ...DEFAULT_SRS_SETTINGS, w }).parameters.w.length).toBe(FSRS_PARAM_COUNT);
  });
});

describe("srs: «já sei» e + card", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
  });
  it("markKnown cria registro novo marcado; unmarkKnown apaga com tombstone", async () => {
    const dose = await loadFixtureDose(1);
    const g = await markKnown(dose, dose.cards[1]);
    expect({ ...g, rec: strip(g.rec) }).toMatchSnapshot("markKnown");
    expect((await listKnown("ko")).map((c) => c.key)).toEqual(["ko-T1-01::w-나무"]);
    await unmarkKnown(g.rec);
    expect(await db.cards.count()).toBe(0);
    expect((await db.tombstones.toArray()).map((t) => t.tid)).toEqual(["card:ko-T1-01::w-나무"]);
  });
  it("markKnown marca o registro da palavra em OUTRA dose", async () => {
    const dose = await loadFixtureDose(1);
    await putCards(rec({ key: "ko-T1-02::w-가방", state: 2, reps: 3 }));
    const g = await markKnown(dose, dose.cards[0]);
    expect([g.rec.key, g.rec.known, g.wasNew, g.reviewUid]).toEqual(["ko-T1-02::w-가방", true, false, ""]);
    expect(await db.cards.count()).toBe(1);
    await unmarkKnown(g.rec); // reps > 0: fica, sem a marca
    expect((await db.cards.get("ko-T1-02::w-가방"))!.known).toBe(false);
  });
  it("undoGrade de um «já sei» novo apaga o card e não mexe no log", async () => {
    const dose = await loadFixtureDose(1);
    const g = await markKnown(dose, dose.cards[0]);
    await undoGrade(g);
    expect([await db.cards.count(), await db.tombstones.count()]).toEqual([0, 1]);
  });
  it("addExtraCard: cria uma vez, origin extra; o «já sei» dele só sai da marca", async () => {
    const dose = await loadFixtureDose(1);
    const a = await addExtraCard(dose, dose.cards[2]);
    const b = await addExtraCard(dose, dose.cards[2]);
    expect(strip(a)).toMatchSnapshot("extra");
    expect(a).toEqual(b);
    const k = await markKnown(dose, dose.cards[2]);
    await unmarkKnown(k.rec);
    expect((await db.cards.get(a.key))!.known).toBe(false);
  });
});

describe("srs: ações no card", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
  });
  it("buryCard / suspendCard / unsuspendAll", async () => {
    await putCards(rec({ key: "a::w-1", state: 2, due: NOW - DAY }), rec({ key: "a::w-2", state: 2, due: NOW - DAY }));
    const b = await buryCard((await db.cards.get("a::w-1"))!);
    expect(b.buriedUntil).toBe(nextDayStart());
    const s = await suspendCard((await db.cards.get("a::w-2"))!);
    expect(s.suspended).toBe(true);
    expect(await countDue("ko")).toBe(0);
    expect(await unsuspendAll("ko")).toBe(1);
    expect(await unsuspendAll("ko")).toBe(0);
    expect(await countDue("ko")).toBe(1);
  });
  it("forgetCard volta a novo e tira o adiamento", async () => {
    await putCards(rec({ key: "a::w-1", state: 2, due: NOW - DAY, stability: 9, difficulty: 6, reps: 5, lapses: 2, scheduled_days: 9, last_review: NOW - 9 * DAY, buriedUntil: NOW + DAY }));
    const f = await forgetCard((await db.cards.get("a::w-1"))!);
    expect(strip(f)).toMatchSnapshot("forget");
  });
});

describe("srs: rescheduleAll", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
  });
  it("repete o histórico com os ajustes atuais", async () => {
    const dose = await loadFixtureDose(1);
    let g = await gradeNew(dose, dose.cards[0], 3, 10);
    advanceClock(10 * MIN);
    g = await gradeCard(g.rec, 3, 10);
    advanceClock(3 * DAY);
    g = await gradeCard(g.rec, 3, 10);
    await gradeNew(dose, dose.cards[1], 4, 10);
    expect(await rescheduleAll("ko")).toEqual({ changed: 0, total: 2 });
    await saveSrs({ requestRetention: 0.8 });
    const r = await rescheduleAll("ko");
    const cards = (await db.cards.toArray()).map((c: CardRecord) => ({ key: c.key, due: c.due - NOW, state: c.state, s: +c.stability.toFixed(4) }));
    expect({ r, cards }).toMatchSnapshot("reagendado");
    expect(await rescheduleAll("ja")).toEqual({ changed: 0, total: 0 });
  });
});
