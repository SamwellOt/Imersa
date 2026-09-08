// SRS service — wraps ts-fsrs (FSRS-6), com o comportamento do Anki:
// passos de (re)aprendizado, limites diários contados do log, fila com
// prioridade (aprendendo → vencidos → novos), "learn ahead", adiar/suspender/
// reiniciar card, reagendamento por histórico e parâmetros otimizáveis.
import {
  createEmptyCard,
  default_w,
  fsrs,
  generatorParameters,
  Rating,
  State,
  type Card as FsrsCard,
  type FSRSHistory,
  type Grade,
  type StepUnit,
} from "ts-fsrs";
import type { Dose, SentenceCard } from "@/types/dose";
import {
  db,
  getSetting,
  newUid,
  tombstone,
  type CardRecord,
} from "./db";
import { scheduleSync } from "./sync";
import { DAY_MS, dayKey, daysBetween, dueOnDay, nextDayStart } from "./utils";

export const RATINGS = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as const;
export type ReviewRating = (typeof RATINGS)[number];

/** Ordem dos cards vencidos (Anki: "review sort order"). */
export type ReviewOrder = "due" | "retrievability" | "random";
/** Onde os cards novos entram em relação aos vencidos (Anki: "new/review order"). */
export type NewOrder = "mix" | "after" | "before";

export interface SrsSettings {
  newPerDay: number;
  maxReviewsPerDay: number;
  requestRetention: number; // 0..1 target recall
  enableFuzz: boolean;
  /** Passos de aprendizado (Anki: "1m 10m"). Vazio = só o FSRS decide. */
  learningSteps: string[];
  /** Passos de reaprendizado depois de um "De novo" (Anki: "10m"). */
  relearningSteps: string[];
  /** Intervalo máximo, em dias (Anki: 36500). */
  maximumInterval: number;
  /** Minutos que um card em aprendizado pode ser mostrado antes da hora quando
   *  não há mais nada para estudar (Anki: "learn ahead limit", 20 min). */
  learnAheadMin: number;
  reviewOrder: ReviewOrder;
  newOrder: NewOrder;
  /** Parâmetros FSRS. `null` = padrão do FSRS-6. Vêm do otimizador (/otimizar)
   *  ou colados à mão, como no Anki. */
  w: number[] | null;
  /** Quando e com quantas revisões `w` foi otimizado (só informativo). */
  wOptimizedAt: number | null;
  wReviews: number;
}

export const DEFAULT_SRS_SETTINGS: SrsSettings = {
  newPerDay: 20,
  maxReviewsPerDay: 200,
  requestRetention: 0.9,
  enableFuzz: true,
  learningSteps: ["1m", "10m"],
  relearningSteps: ["10m"],
  maximumInterval: 36500,
  learnAheadMin: 20,
  reviewOrder: "due",
  newOrder: "mix",
  w: null,
  wOptimizedAt: null,
  wReviews: 0,
};

/** Quantos parâmetros o FSRS-6 tem (17 e 19 são de versões antigas e migram). */
export const FSRS_PARAM_COUNT = 21;
export const FSRS_DEFAULT_W: readonly number[] = default_w;
/** Mínimo de revisões para o otimizador valer a pena — o mesmo piso do Anki. */
export const MIN_REVIEWS_TO_OPTIMIZE = 400;
/** Tempo máximo que uma resposta conta (Anki: 60 s). Ir tomar café não vira
 *  "levou 40 min neste card" nas estatísticas. */
export const MAX_ANSWER_MS = 60_000;

const STEP_RE = /^\d+(\.\d+)?[mhd]$/;

/** "1m 10m" → ["1m","10m"]; `null` se algum passo for inválido. */
export function parseSteps(text: string): string[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  return parts.every((p) => STEP_RE.test(p)) ? parts : null;
}

export function stepsToText(steps: string[]): string {
  return steps.join(" ");
}

/** Lista de parâmetros válida (17, 19 ou 21 números finitos) ou `null`. */
export function sanitizeW(w: unknown): number[] | null {
  if (!Array.isArray(w)) return null;
  if (![17, 19, FSRS_PARAM_COUNT].includes(w.length)) return null;
  const nums = w.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/** Ajustes salvos completados com os padrões — quem gravou a versão antiga
 *  (4 campos) continua funcionando sem migração. */
function normalizeSettings(raw: Partial<SrsSettings> | null | undefined): SrsSettings {
  const s = { ...DEFAULT_SRS_SETTINGS, ...(raw ?? {}) };
  s.learningSteps = Array.isArray(s.learningSteps) && s.learningSteps.every((x) => STEP_RE.test(x))
    ? s.learningSteps
    : DEFAULT_SRS_SETTINGS.learningSteps;
  s.relearningSteps = Array.isArray(s.relearningSteps) && s.relearningSteps.every((x) => STEP_RE.test(x))
    ? s.relearningSteps
    : DEFAULT_SRS_SETTINGS.relearningSteps;
  s.w = sanitizeW(s.w);
  if (!(s.maximumInterval >= 1)) s.maximumInterval = DEFAULT_SRS_SETTINGS.maximumInterval;
  if (!(s.learnAheadMin >= 0)) s.learnAheadMin = DEFAULT_SRS_SETTINGS.learnAheadMin;
  if (!(s.requestRetention > 0.5 && s.requestRetention < 1)) s.requestRetention = 0.9;
  return s;
}

export async function getSrsSettings(): Promise<SrsSettings> {
  return normalizeSettings(await getSetting<Partial<SrsSettings> | null>("srs", null));
}

export function scheduler(s: SrsSettings) {
  return fsrs(
    generatorParameters({
      request_retention: s.requestRetention,
      maximum_interval: s.maximumInterval,
      enable_fuzz: s.enableFuzz,
      enable_short_term: true,
      learning_steps: s.learningSteps as StepUnit[],
      relearning_steps: s.relearningSteps as StepUnit[],
      ...(s.w ? { w: s.w } : {}),
    }),
  );
}

// ---- conversion between our CardRecord and ts-fsrs Card ----

/** Card agendado em dias (revisão, ou passo de aprendizado ≥ 1 dia) — o que no
 *  Anki é uma *data*, não um horário. Os passos em minutos ficam de fora. */
function isDayCard(c: { scheduled_days: number }): boolean {
  return c.scheduled_days >= 1;
}

/**
 * `CardRecord` → card do ts-fsrs. Com `elapsedFrom` (o instante da revisão que
 * vai acontecer), um card em dias tem a última revisão reposicionada para
 * "há k dias de estudo": o ts-fsrs mede `elapsed_days` como
 * `floor((agora − last_review) / 24 h)`, e o Anki por dia de estudo (virada às
 * 4h). Sem isso, um card graduado ontem às 23h e revisto hoje às 8h contaria
 * 0 dias — o que zera o ganho de estabilidade — e um "3 d" revisto no 3º dia
 * de manhã contava 2.
 */
function toFsrs(rec: CardRecord, elapsedFrom?: number): FsrsCard {
  let last = rec.last_review;
  if (last != null && elapsedFrom != null && isDayCard(rec)) {
    const k = Math.max(0, daysBetween(dayKey(new Date(last)), dayKey(new Date(elapsedFrom))));
    last = elapsedFrom - k * DAY_MS;
  }
  return {
    due: new Date(rec.due),
    stability: rec.stability,
    difficulty: rec.difficulty,
    elapsed_days: rec.elapsed_days,
    scheduled_days: rec.scheduled_days,
    learning_steps: rec.learning_steps ?? 0,
    reps: rec.reps,
    lapses: rec.lapses,
    state: rec.state,
    last_review: last ? new Date(last) : undefined,
  } as FsrsCard;
}

/**
 * Vencimento do card devolvido pelo ts-fsrs, no molde do Anki: intervalo em
 * dias vence no **início do dia de estudo** (`dueOnDay`), então "1 dia" dado às
 * 22h já aparece na manhã seguinte (a partir das 4h). Passos em minutos
 * mantêm a hora exata.
 */
function snapDue(c: FsrsCard): number {
  const due = new Date(c.due).getTime();
  if (!isDayCard(c)) return due;
  const from = c.last_review ? new Date(c.last_review).getTime() : Date.now();
  return dueOnDay(from, (due - from) / DAY_MS);
}

function applyFsrs(rec: CardRecord, c: FsrsCard): CardRecord {
  return {
    ...rec,
    due: snapDue(c),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps ?? 0,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? new Date(c.last_review).getTime() : undefined,
  };
}

export function cardKey(doseId: string, cardId: string): string {
  return `${doseId}::${cardId}`;
}

// ---- card predicates ----

/** Fora de toda fila: suspenso, ou adiado até um instante ainda por vir. */
export function isActive(c: CardRecord, now = Date.now()): boolean {
  return !c.suspended && !(c.buriedUntil != null && c.buriedUntil > now);
}

export function isLearningState(c: CardRecord): boolean {
  return c.state === State.Learning || c.state === State.Relearning;
}

/** Instante em que o card volta a poder aparecer (vencimento, ou o fim do adiamento). */
function availableAt(c: CardRecord): number {
  return Math.max(c.due, c.buriedUntil ?? 0);
}

async function activeCards(language: string, now = Date.now()): Promise<CardRecord[]> {
  return (await db.cards.where("language").equals(language).toArray()).filter((c) => isActive(c, now));
}

// ---- daily counters ----

export interface TodayCounts {
  /** Notas dadas hoje, de qualquer tipo. */
  reviewsDone: number;
  /** Cards que receberam a primeira nota hoje (contam no teto de novos). */
  newIntroduced: number;
  /** Notas dadas hoje em cards que estavam em revisão (contam no teto de
   *  revisões — aprendizado não conta, como no Anki). */
  reviewCardsDone: number;
}

export async function getTodayCounts(language: string): Promise<TodayCounts> {
  // Counted from actual GRADES today — a card only counts once it's been rated.
  const today = dayKey();
  const revs = await db.reviewLog.where("language").equals(language).toArray();
  const todays = revs.filter((r) => r.day === today);
  return {
    reviewsDone: todays.length,
    newIntroduced: todays.filter((r) => r.state === State.New).length,
    reviewCardsDone: todays.filter((r) => r.state === State.Review).length,
  };
}

/**
 * Imersão entra como EVENTO, não como contador. Dois aparelhos no mesmo dia
 * somam; um contador sincronizado por last-write-wins perderia o tempo do outro.
 */
export async function logImmersion(language: string, ms: number, doseId?: string): Promise<void> {
  if (ms <= 0) return;
  const now = Date.now();
  await db.immersionLog.add({
    uid: newUid(), language, day: dayKey(new Date(now)), ms, at: now,
    ...(doseId ? { doseId } : {}),
  });
  scheduleSync();
}

// ---- queue building ----
// A card becomes a stored record only once it's GRADED. Until then, a dose's
// unseen cards appear as "new candidates" (no record) and consume no allowance —
// opening or skipping the review counts nothing.

export interface QueueEntry {
  key: string; // `${doseId}::${cardId}`
  doseId: string;
  cardId: string;
  isNew: boolean;
  rec?: CardRecord; // present only for already-seen (review) cards
}

export interface DoseQueue {
  entries: QueueEntry[];
  /**
   * Palavras desta dose ainda **não vistas** que não couberam no teto diário de
   * palavras novas. Enquanto isso for > 0 a dose não está pronta para fechar: a
   * fila vem vazia não porque a lição acabou, mas porque a cota do dia acabou.
   */
  heldBack: number;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Ordena os cards em revisão conforme o ajuste (Anki: "review sort order"). */
function orderReviews(cards: CardRecord[], s: SrsSettings, now: number): CardRecord[] {
  if (s.reviewOrder === "random") return shuffle([...cards]);
  if (s.reviewOrder === "retrievability") {
    const f = scheduler(s);
    const r = new Map(cards.map((c) => [c.key, f.get_retrievability(toFsrs(c, now), new Date(now), false)]));
    return [...cards].sort((a, b) => r.get(a.key)! - r.get(b.key)!);
  }
  // "due": data de vencimento, e aleatório dentro do mesmo dia — assim a
  // primeira metade da fila não é sempre a mesma dose.
  const jitter = new Map(cards.map((c) => [c.key, Math.random()]));
  return [...cards].sort((a, b) => {
    const da = dayKey(new Date(a.due));
    const dbb = dayKey(new Date(b.due));
    if (da !== dbb) return da < dbb ? -1 : 1;
    return jitter.get(a.key)! - jitter.get(b.key)!;
  });
}

/**
 * Monta a fila no espírito do Anki: **aprendendo** (vencidos, do mais atrasado)
 * primeiro, depois os **vencidos em revisão** na ordem escolhida, e os **novos**
 * misturados por igual (ou antes/depois). Se não há nada vencido, cards em
 * aprendizado que vencem nos próximos `learnAheadMin` entram adiantados.
 */
function assemble(
  seen: CardRecord[],
  news: QueueEntry[],
  s: SrsSettings,
  now: number,
): QueueEntry[] {
  const learningDue = seen
    .filter((c) => isLearningState(c) && c.due <= now)
    .sort((a, b) => a.due - b.due);
  const reviewDue = orderReviews(
    seen.filter((c) => !isLearningState(c) && c.due <= now),
    s,
    now,
  );
  let seenQueue = [...learningDue, ...reviewDue];
  if (!seenQueue.length && !news.length && s.learnAheadMin > 0) {
    const cutoff = now + s.learnAheadMin * 60_000;
    seenQueue = seen
      .filter((c) => isLearningState(c) && c.due <= cutoff)
      .sort((a, b) => a.due - b.due);
  }
  const revs: QueueEntry[] = seenQueue.map((r) => ({
    key: r.key, doseId: r.doseId, cardId: r.cardId, isNew: false, rec: r,
  }));

  if (s.newOrder === "before") return [...news, ...revs];
  if (s.newOrder === "after" || !revs.length) return [...revs, ...news];
  if (!news.length) return revs;
  // mix: espalha os novos por igual ao longo dos vencidos
  const out: QueueEntry[] = [];
  const total = revs.length + news.length;
  let ni = 0;
  let ri = 0;
  for (let i = 0; i < total; i++) {
    const wantNew = ni < news.length && (ri >= revs.length || (i + 1) * news.length > (ni + 0.5) * total);
    out.push(wantNew ? news[ni++] : revs[ri++]);
  }
  return out;
}

/**
 * Fila da fase "Revisão" **da dose** — escopo fechado nas palavras dela:
 * as ainda não vistas (dentro do teto diário) + as desta mesma dose que
 * venceram. Vencidos de *outras* doses ficam para a revisão avulsa (`/review`);
 * antes eles entravam aqui e a fase virava "1 de 220" em vez de "1 de 20",
 * transformando o fecho da lição numa maratona.
 */
export async function buildDoseQueue(dose: Dose, settings?: SrsSettings): Promise<DoseQueue> {
  const s = settings ?? (await getSrsSettings());
  const now = Date.now();
  const mineAll = await db.cards.where("doseId").equals(dose.id).toArray();
  const existingKeys = new Set(mineAll.map((c) => c.key));
  const mine = mineAll.filter((c) => isActive(c, now));

  const { newIntroduced } = await getTodayCounts(dose.language);
  const allowance = Math.max(0, s.newPerDay - newIntroduced);
  const unseen = dose.cards.filter((c) => !existingKeys.has(cardKey(dose.id, c.id)));
  const news: QueueEntry[] = unseen
    .slice(0, allowance)
    .map((c) => ({ key: cardKey(dose.id, c.id), doseId: dose.id, cardId: c.id, isNew: true }));

  return { entries: assemble(mine, news, s, now), heldBack: unseen.length - news.length };
}

/** Standalone review: only already-seen cards due now (new cards come from doses). */
export async function buildDueQueue(language: string, settings?: SrsSettings): Promise<QueueEntry[]> {
  const s = settings ?? (await getSrsSettings());
  const now = Date.now();
  const active = await activeCards(language, now);
  // Teto de revisões do dia, contado do log (não por sessão): abrir a tela
  // três vezes não triplica o teto. Aprendizado não conta, como no Anki.
  const { reviewCardsDone } = await getTodayCounts(language);
  const allowance = Math.max(0, s.maxReviewsPerDay - reviewCardsDone);
  const learning = active.filter((c) => isLearningState(c));
  const reviews = active
    .filter((c) => !isLearningState(c) && c.due <= now)
    .sort((a, b) => a.due - b.due)
    .slice(0, allowance);
  return assemble([...learning, ...reviews], [], s, now);
}

/** Onde uma sessão de revisão busca os cards que voltam: a dose (fase da dose) ou
 *  o idioma inteiro (revisão avulsa). */
export type QueueScope = { language: string; doseId?: string };

/**
 * Cards **em (re)aprendizado** do escopo que estão vencidos agora — ou, com
 * `aheadMin`, que vencem até daqui a tantos minutos. É o "voltar para a fila"
 * do Anki: um "De novo" retorna em ~1 min no meio da sessão, e no fim dela os
 * que faltam poucos minutos entram adiantados em vez de deixar o aluno esperando.
 *
 * O escopo vem do BANCO, não de uma lista guardada em memória pela sessão: uma
 * recarga da página (ou a aba descartada pelo celular) no meio da lição
 * perdia essa lista, o learn-ahead trazia só o que foi avaliado depois e a
 * dose fechava com quase todos os cards ainda em aprendizado.
 */
export async function dueLearning(
  scope: QueueScope,
  aheadMin = 0,
  now = Date.now(),
): Promise<CardRecord[]> {
  const cutoff = now + aheadMin * 60_000;
  const recs = scope.doseId
    ? await db.cards.where("doseId").equals(scope.doseId).toArray()
    : await db.cards.where("language").equals(scope.language).toArray();
  return recs
    .filter((r) => isLearningState(r) && isActive(r, now) && r.due <= cutoff)
    .sort((a, b) => a.due - b.due);
}

/**
 * Quando o próximo card ainda não vencido vence (epoch ms), ou `null` se não há
 * nenhum agendado. É o que permite acordar a UI na hora certa em vez de ficar
 * varrendo o banco de segundo em segundo.
 */
export async function nextDueAt(language: string): Promise<number | null> {
  const now = Date.now();
  const future = (await db.cards.where("language").equals(language).toArray())
    .filter((c) => !c.suspended && availableAt(c) > now)
    .map(availableAt);
  return future.length ? Math.min(...future) : null;
}

/** Vencidos do idioma que **não** pertencem a esta dose — o resto do dia. */
export async function countDueElsewhere(language: string, doseId: string): Promise<number> {
  const now = Date.now();
  return (await activeCards(language, now)).filter((c) => c.due <= now && c.doseId !== doseId).length;
}

/** Cards já vistos que estão vencidos agora (dashboard / badge da navegação). */
/** O card vencido há mais tempo (para o Hoje mostrar "o mais atrasado"). */
export async function mostOverdue(language: string): Promise<CardRecord | null> {
  const now = Date.now();
  const due = (await activeCards(language, now)).filter((c) => c.due <= now);
  if (!due.length) return null;
  return due.reduce((a, c) => (c.due < a.due ? c : a));
}

/**
 * Cards em (re)aprendizado que ainda não venceram mas entram na revisão avulsa
 * pelo "learn ahead" (vencem em até `learnAheadMin`). O Hoje dizia "0 vencidos"
 * enquanto /review abria com 6 cards — este número explica a diferença.
 */
export async function countLearnAhead(language: string, settings?: SrsSettings): Promise<number> {
  const s = settings ?? (await getSrsSettings());
  const now = Date.now();
  const cutoff = now + s.learnAheadMin * 60_000;
  return (await activeCards(language, now)).filter(
    (c) => isLearningState(c) && c.due > now && c.due <= cutoff,
  ).length;
}

export async function countDue(language: string): Promise<number> {
  const now = Date.now();
  return (await activeCards(language, now)).filter((c) => c.due <= now).length;
}

/**
 * Quantas palavras novas desta dose ainda podem entrar hoje = palavras nunca
 * vistas, limitadas pelo que sobrou do teto diário. Usa `cardCount` do `DoseRef`
 * para não precisar baixar o `dose.json` inteiro no dashboard.
 */
export async function countNewReady(
  doseId: string,
  language: string,
  cardCount: number,
  settings?: SrsSettings,
): Promise<number> {
  const s = settings ?? (await getSrsSettings());
  const seen = await db.cards.where("doseId").equals(doseId).count();
  const unseen = Math.max(0, cardCount - seen);
  const { newIntroduced } = await getTodayCounts(language);
  return Math.min(unseen, Math.max(0, s.newPerDay - newIntroduced));
}

// ---- grading ----

export interface IntervalPreview {
  rating: ReviewRating;
  card: FsrsCard;
  /** human label like "10 min", "1 d", "4 d" */
  label: string;
}

export function humanInterval(from: number, to: number): string {
  const ms = Math.max(0, to - from);
  const min = ms / 60000;
  if (min < 1) return "<1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)} h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)} d`;
  const mo = d / 30;
  if (mo < 12) {
    const n = Math.round(mo);
    return `${n} ${n === 1 ? "mês" : "meses"}`;
  }
  return `${(d / 365).toFixed(1)} a`;
}

/** "12 d", "3 meses" a partir de um número de dias. */
export function humanDays(days: number): string {
  return humanInterval(0, Math.max(0, days) * 86_400_000);
}

function previewFrom(fc: FsrsCard, s: SrsSettings): Record<ReviewRating, IntervalPreview> {
  const now = new Date();
  const sched = scheduler(s).repeat(fc, now);
  const out = {} as Record<ReviewRating, IntervalPreview>;
  for (const r of RATINGS) {
    const c = sched[r as Grade].card;
    // Em dias, o rótulo é o intervalo em dias (Anki mostra "1 d", não "18 h"):
    // o card vence no início do dia, não na mesma hora.
    const label = isDayCard(c)
      ? humanDays(Math.max(1, Math.round((new Date(c.due).getTime() - now.getTime()) / DAY_MS)))
      : humanInterval(now.getTime(), new Date(c.due).getTime());
    out[r] = { rating: r, card: c, label };
  }
  return out;
}

export async function previewIntervals(rec: CardRecord, settings?: SrsSettings) {
  return previewFrom(toFsrs(rec, Date.now()), settings ?? (await getSrsSettings()));
}

/** Interval preview for an unseen card (before it has a record). */
export async function previewNewIntervals(settings?: SrsSettings) {
  return previewFrom(createEmptyCard(new Date()), settings ?? (await getSrsSettings()));
}

/**
 * Resultado de uma avaliação, com o necessário para desfazê-la: o estado
 * anterior do card (`prev`, ou `null` se ele nasceu agora) e o id da linha de log.
 */
export interface GradeResult {
  rec: CardRecord;
  prev: CardRecord | null;
  reviewUid: string;
  wasNew: boolean;
  language: string;
}

export async function gradeCard(
  rec: CardRecord,
  rating: ReviewRating,
  elapsedMs: number,
  settings?: SrsSettings,
): Promise<GradeResult> {
  const s = settings ?? (await getSrsSettings());
  const now = new Date();
  const stateBefore = rec.state;
  const nextCard = scheduler(s).next(toFsrs(rec, now.getTime()), now, rating as Grade).card;
  // Um card reiniciado ou adiado que recebe nota volta ao fluxo normal.
  const { buriedUntil: _b, ...base } = rec;
  const updated = { ...applyFsrs(base as CardRecord, nextCard), updatedAt: now.getTime() };
  const reviewUid = newUid();
  await db.transaction("rw", [db.cards, db.reviewLog], async () => {
    await db.cards.put(updated);
    await db.reviewLog.add({
      uid: reviewUid,
      key: rec.key,
      doseId: rec.doseId,
      language: rec.language,
      rating,
      reviewedAt: now.getTime(),
      day: dayKey(now),
      elapsedMs: Math.min(Math.max(0, elapsedMs), MAX_ANSWER_MS),
      state: stateBefore,
    });
  });
  scheduleSync();
  return { rec: updated, prev: rec, reviewUid, wasNew: false, language: rec.language };
}

/** First grade of an unseen card: creates its record (this is when it "counts"). */
export async function gradeNew(
  dose: Dose,
  card: SentenceCard,
  rating: ReviewRating,
  elapsedMs: number,
  settings?: SrsSettings,
): Promise<GradeResult> {
  const s = settings ?? (await getSrsSettings());
  const key = cardKey(dose.id, card.id);
  // A palavra já tem registro (outro aparelho avaliou antes de sincronizar, ou
  // a fila foi montada antes de a sincronização chegar)? Então isto é uma
  // revisão, não uma estreia: sobrescrever o registro apagaria o estado FSRS
  // de lá e a cota de novos seria cobrada duas vezes.
  const existing = await db.cards.get(key);
  if (existing) return gradeCard(existing, rating, elapsedMs, s);
  const now = new Date();
  const next = scheduler(s).next(createEmptyCard(now), now, rating as Grade).card;
  const rec: CardRecord = {
    key,
    doseId: dose.id,
    cardId: card.id,
    language: dose.language,
    due: snapDue(next),
    stability: next.stability,
    difficulty: next.difficulty,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    learning_steps: next.learning_steps ?? 0,
    reps: next.reps,
    lapses: next.lapses,
    state: next.state,
    last_review: now.getTime(),
    introducedAt: now.getTime(),
    updatedAt: now.getTime(),
    topikLevel: card.topikLevel ?? null,
  };
  const reviewUid = newUid();
  await db.transaction("rw", [db.cards, db.reviewLog], async () => {
    await db.cards.put(rec);
    await db.reviewLog.add({
      uid: reviewUid, key, doseId: dose.id, language: dose.language, rating,
      reviewedAt: now.getTime(), day: dayKey(now),
      elapsedMs: Math.min(Math.max(0, elapsedMs), MAX_ANSWER_MS), state: State.New,
    });
  });
  scheduleSync();
  return { rec, prev: null, reviewUid, wasNew: true, language: dose.language };
}

/**
 * Desfaz a última avaliação: restaura o estado FSRS anterior (ou apaga o card,
 * se ele só existia por causa dessa nota) e remove o evento do log. Os
 * contadores do dia são derivados do log, então se corrigem sozinhos.
 * Sem isso, um clique errado é permanente.
 */
export async function undoGrade(g: GradeResult): Promise<void> {
  if (g.prev) {
    await db.cards.put({ ...g.prev, updatedAt: Date.now() });
  } else {
    await db.cards.delete(g.rec.key);
    await tombstone("card", g.rec.key);
  }
  await db.reviewLog.delete(g.reviewUid);
  await tombstone("review", g.reviewUid);
  scheduleSync();
}

// ---- card actions (Anki: bury / suspend / forget) ----

/** Adia o card até o próximo dia de estudo (Anki "bury"). */
export async function buryCard(rec: CardRecord): Promise<CardRecord> {
  const updated = { ...rec, buriedUntil: nextDayStart(), updatedAt: Date.now() };
  await db.cards.put(updated);
  scheduleSync();
  return updated;
}

/** Tira o card de todas as filas até ser reativado (Anki "suspend"). */
export async function suspendCard(rec: CardRecord): Promise<CardRecord> {
  const updated = { ...rec, suspended: true, updatedAt: Date.now() };
  await db.cards.put(updated);
  scheduleSync();
  return updated;
}

export async function countSuspended(language: string): Promise<number> {
  return (await db.cards.where("language").equals(language).toArray()).filter((c) => c.suspended).length;
}

/** Reativa todos os suspensos do idioma. */
export async function unsuspendAll(language: string): Promise<number> {
  const now = Date.now();
  const sus = (await db.cards.where("language").equals(language).toArray()).filter((c) => c.suspended);
  if (!sus.length) return 0;
  await db.cards.bulkPut(sus.map((c) => ({ ...c, suspended: false, updatedAt: now })));
  scheduleSync();
  return sus.length;
}

/**
 * Reinicia o card (Anki "forget"): volta a novo, sem memória de estabilidade e
 * dificuldade. O histórico de notas fica; o contador de repetições também.
 */
export async function forgetCard(rec: CardRecord, settings?: SrsSettings): Promise<CardRecord> {
  const s = settings ?? (await getSrsSettings());
  const now = new Date();
  const c = scheduler(s).forget(toFsrs(rec), now, false).card;
  const { buriedUntil: _b, ...base } = rec;
  const updated = { ...applyFsrs(base as CardRecord, c), updatedAt: now.getTime() };
  await db.cards.put(updated);
  scheduleSync();
  return updated;
}

// ---- card info (o "Card info" do Anki, resumido) ----

export interface CardInfo {
  /** Probabilidade de lembrar agora, 0..1 (só faz sentido em revisão). */
  retrievability: number;
  stability: number; // dias
  difficulty: number; // 1..10
  intervalDays: number;
  reps: number;
  lapses: number;
}

export function cardInfo(rec: CardRecord, s: SrsSettings, now = Date.now()): CardInfo {
  const f = scheduler(s);
  return {
    retrievability: rec.state === State.New ? 0 : f.get_retrievability(toFsrs(rec, now), new Date(now), false),
    stability: rec.stability,
    difficulty: rec.difficulty,
    intervalDays: rec.scheduled_days,
    reps: rec.reps,
    lapses: rec.lapses,
  };
}

// ---- reschedule (Anki: "reschedule cards on change") ----

/**
 * Recalcula o estado de cada card **repetindo o histórico de notas** com os
 * parâmetros atuais (novos `w`, retenção alvo, passos). É o que o Anki faz ao
 * marcar "reagendar cards" depois de otimizar. Só o estado muda — o log fica.
 */
export async function rescheduleAll(
  language: string,
  settings?: SrsSettings,
): Promise<{ changed: number; total: number }> {
  const s = settings ?? (await getSrsSettings());
  const f = scheduler(s);
  const now = new Date();
  const [cards, logs] = await Promise.all([
    db.cards.where("language").equals(language).toArray(),
    db.reviewLog.where("language").equals(language).toArray(),
  ]);
  const byKey = new Map<string, FSRSHistory[]>();
  for (const r of logs.sort((a, b) => a.reviewedAt - b.reviewedAt)) {
    if (r.rating < 1 || r.rating > 4) continue;
    let arr = byKey.get(r.key);
    if (!arr) byKey.set(r.key, (arr = []));
    arr.push({ rating: r.rating as Grade, review: new Date(r.reviewedAt) });
  }
  const updates: CardRecord[] = [];
  for (const c of cards) {
    const hist = byKey.get(c.key);
    if (!hist?.length) continue;
    const { collections } = f.reschedule(toFsrs(c), hist, {
      skipManual: true,
      update_memory_state: true,
      now,
    });
    const last = collections[collections.length - 1]?.card;
    if (!last) continue;
    const next = applyFsrs(c, last);
    const same =
      next.due === c.due &&
      Math.abs(next.stability - c.stability) < 1e-6 &&
      Math.abs(next.difficulty - c.difficulty) < 1e-6 &&
      next.state === c.state;
    if (same) continue;
    updates.push({ ...next, updatedAt: now.getTime() });
  }
  if (updates.length) {
    await db.cards.bulkPut(updates);
    scheduleSync();
  }
  return { changed: updates.length, total: cards.length };
}

// ---- lookups for rendering a card's face ----

/** Map a CardRecord back to its authored SentenceCard within a loaded Dose. */
export function findSentenceCard(dose: Dose, cardId: string): SentenceCard | undefined {
  return dose.cards.find((c) => c.id === cardId);
}
