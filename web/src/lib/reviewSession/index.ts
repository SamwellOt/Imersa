// Sessão de revisão (ver GLOSSARY.md). Interface pública: a fábrica, a visão e os
// tipos. `queue.ts` e `resolve.ts` são internos ao módulo.
export { createReviewSession } from "./session";
export type {
  ReviewSession, ReviewSessionOptions, ReviewView, ReviewSummary, Estado, Acao,
} from "./session";
export type { Kind, ResolvedItem } from "./queue";
