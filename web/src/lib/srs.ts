// SRS service — wraps ts-fsrs (FSRS-6), com o comportamento do Anki:
// passos de (re)aprendizado, limites diários contados do log, fila com
// prioridade (aprendendo → vencidos → novos), "learn ahead", adiar/suspender/
// reiniciar card, reagendamento por histórico e parâmetros otimizáveis.
//
// Este arquivo é só a API pública (os nomes de sempre). O código mora em camadas:
//   srsCore.ts  — regra pura: ajustes, conversão ts-fsrs, vencimento, nota
//   srsQueue.ts — regra pura: montagem e ordem das filas, contadores do dia
//   srsRepo.ts  — dados: Dexie (transações) + scheduleSync
import type { Dose, SentenceCard } from "@/types/dose";
import { findCard } from "./cards";

export * from "./srsRepo";
export type { TodayCounts, QueueEntry, DoseQueue } from "./srsQueue";
export {
  RATINGS, DEFAULT_SRS_SETTINGS, FSRS_PARAM_COUNT, FSRS_DEFAULT_W, MIN_REVIEWS_TO_OPTIMIZE, MAX_ANSWER_MS,
  parseSteps, stepsToText, sanitizeW, scheduler, cardKey, isActive, isLearningState,
  humanInterval, humanDays, cardInfo,
  type ReviewRating, type ReviewOrder, type NewOrder, type SrsSettings, type IntervalPreview,
  type GradeResult, type CardInfo,
} from "./srsCore";

// ---- lookups for rendering a card's face ----

/** Map a CardRecord back to its authored SentenceCard within a loaded Dose. */
export function findSentenceCard(dose: Dose, cardId: string): SentenceCard | undefined {
  return findCard(dose, cardId);
}
