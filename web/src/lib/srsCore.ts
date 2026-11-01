// Regra pura do SRS: ajustes, conversão CardRecord ↔ ts-fsrs, vencimento por
// dia de estudo e predicados de card. Nada aqui toca o banco (o `db.ts` só
// entra pelos TIPOS). Faz parte da divisão em camadas de `srs.ts`
// (srsCore = regra · srsQueue = montagem de fila · srsRepo = Dexie + sync).
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
// `newUid` é o único valor que vem do db.ts (gera o id do evento de nota);
// importá-lo não abre o banco.
import { newUid, type CardRecord, type ReviewRecord } from "./db";
import { DAY_MS, dayKey, daysBetween, dueOnDay } from "./utils";

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
  /** Cards de frase i+1 SEPARADOS (`dose.sentenceCards`), cards de escuta. Desde
   *  09/2026 a frase i+1 mora no próprio card da palavra (frente e verso), então
   *  isto vem desligado; desligado, os que já existem também saem das filas
   *  (nada é apagado — religar os traz de volta). */
  sentenceCards: boolean;
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
  sentenceCards: false,
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
export function normalizeSettings(raw: Partial<SrsSettings> | null | undefined): SrsSettings {
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
export function isDayCard(c: { scheduled_days: number }): boolean {
  return c.scheduled_days >= 1;
}

/**
 * Card já visto (fora de New) sem `last_review` — backup antigo, import, app
 * velho noutro aparelho. O ts-fsrs exige a data (FSRSValidationError: Invalid
 * date) e o verso do card quebrava. A melhor estimativa é o vencimento menos o
 * intervalo agendado.
 */
function impliedLastReview(rec: CardRecord): number | undefined {
  if (rec.state === State.New) return undefined;
  return rec.due - Math.max(0, rec.scheduled_days) * DAY_MS;
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
export function toFsrs(rec: CardRecord, elapsedFrom?: number): FsrsCard {
  let last = rec.last_review ?? impliedLastReview(rec);
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
    last_review: last != null ? new Date(last) : undefined,
  } as FsrsCard;
}

/**
 * Vencimento do card devolvido pelo ts-fsrs, no molde do Anki: intervalo em
 * dias vence no **início do dia de estudo** (`dueOnDay`), então "1 dia" dado às
 * 22h já aparece na manhã seguinte (a partir das 4h). Passos em minutos
 * mantêm a hora exata.
 */
export function snapDue(c: FsrsCard): number {
  const due = new Date(c.due).getTime();
  if (!isDayCard(c)) return due;
  const from = c.last_review ? new Date(c.last_review).getTime() : Date.now();
  return dueOnDay(from, (due - from) / DAY_MS);
}

export function applyFsrs(rec: CardRecord, c: FsrsCard): CardRecord {
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

/** Fora de toda fila: «já sei», suspenso, ou adiado até um instante ainda por vir. */
export function isActive(c: CardRecord, now = Date.now()): boolean {
  return !c.known && !c.suspended && !(c.buriedUntil != null && c.buriedUntil > now);
}

export function isLearningState(c: CardRecord): boolean {
  return c.state === State.Learning || c.state === State.Relearning;
}

/** Instante em que o card volta a poder aparecer (vencimento, ou o fim do adiamento). */
export function availableAt(c: CardRecord): number {
  return Math.max(c.due, c.buriedUntil ?? 0);
}

/** Card de frase separado com a opção desligada: fora das filas, sem apagar. */
export function hiddenBySettings(c: CardRecord, s: SrsSettings): boolean {
  return c.origin === "sentence" && !s.sentenceCards;
}

// ---- intervalos e nota ----

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

export function previewFrom(fc: FsrsCard, s: SrsSettings): Record<ReviewRating, IntervalPreview> {
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

/**
 * Aplica uma nota ao registro (já fresco do banco). Síncrono — o scheduler é
 * puro — e roda dentro de uma transação rw de cards + reviewLog.
 */
export function applyGrade(
  fresh: CardRecord,
  rating: ReviewRating,
  elapsedMs: number,
  s: SrsSettings,
  now: Date,
): { updated: CardRecord; logEntry: ReviewRecord } {
  const stateBefore = fresh.state;
  const nextCard = scheduler(s).next(toFsrs(fresh, now.getTime()), now, rating as Grade).card;
  // Um card reiniciado ou adiado que recebe nota volta ao fluxo normal.
  const { buriedUntil: _b, ...base } = fresh;
  const updated = { ...applyFsrs(base as CardRecord, nextCard), updatedAt: now.getTime() };
  const logEntry: ReviewRecord = {
    uid: newUid(),
    key: fresh.key,
    doseId: fresh.doseId,
    language: fresh.language,
    rating,
    reviewedAt: now.getTime(),
    day: dayKey(now),
    elapsedMs: Math.min(Math.max(0, elapsedMs), MAX_ANSWER_MS),
    state: stateBefore,
    ...(fresh.origin ? { origin: fresh.origin } : {}),
  };
  return { updated, logEntry };
}

/** Registro "vazio" (card novo, sem memória) para um card desta dose. */
export function freshRecord(dose: Dose, card: SentenceCard, now: number): CardRecord {
  const c = createEmptyCard(new Date(now));
  return {
    key: cardKey(dose.id, card.id), doseId: dose.id, cardId: card.id, language: dose.language,
    due: now, stability: c.stability, difficulty: c.difficulty, elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days, learning_steps: c.learning_steps ?? 0, reps: 0, lapses: 0,
    state: State.New, introducedAt: now, updatedAt: now, topikLevel: card.topikLevel ?? null,
  };
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
 * Repete o histórico de notas de cada card com o scheduler `f` e devolve só os
 * cards cujo estado mudou (com `updatedAt` = `now`). O log não muda.
 */
export function replayHistory(
  cards: CardRecord[],
  logs: ReviewRecord[],
  f: ReturnType<typeof scheduler>,
  now: Date,
): CardRecord[] {
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
  return updates;
}
