// Vocabulário do aluno visto pela LEGENDA: que palavras de cada fala ele já
// fixou, está aprendendo ou nunca estudou. É o que pinta a legenda
// "conhecido/novo" no player e mede a compreensão de cada lição em /progress.
//
// A ponte entre legenda e SRS é o lema: a pipeline grava em cada fala os
// `tokens` (palavras de conteúdo, com posição e forma de dicionário), e o card
// da palavra tem id `w-<lema>` — então "já é card?" é comparar strings, sem
// carregar o dose.json de todas as lições. Só o estado FSRS decide o status:
// nunca a lição em que a palavra apareceu.
import { db } from "./db";
import type { Segment, SegmentToken } from "@/types/dose";

export type WordStatus = "known" | "learning" | "new";
/** lema → status. Palavra fora do mapa = nunca estudada ("new"). */
export type LemmaStatus = Map<string, WordStatus>;

const CARD_PREFIX = "w-";
/** Mesma régua de `levels.ts`: fixada = o FSRS a considera em revisão. */
const STATE_REVIEW = 2;

export function lemmaOfCardId(cardId: string): string | null {
  return cardId.startsWith(CARD_PREFIX) ? cardId.slice(CARD_PREFIX.length) : null;
}

/** Status de cada lema que já virou card do idioma (o registro só nasce na 1ª nota). */
export async function loadLemmaStatus(language: string): Promise<LemmaStatus> {
  const cards = await db.cards.where("language").equals(language).toArray();
  const out: LemmaStatus = new Map();
  for (const c of cards) {
    const lemma = lemmaOfCardId(c.cardId);
    if (!lemma) continue; // card de frase (dose antiga): não é palavra
    const st: WordStatus = c.state === STATE_REVIEW ? "known" : "learning";
    // dedup i+1 garante um card por palavra; se houver dois, o melhor estado vale
    if (out.get(lemma) !== "known") out.set(lemma, st);
  }
  return out;
}

export function statusOf(status: LemmaStatus | null | undefined, lemma: string): WordStatus {
  return status?.get(lemma) ?? "new";
}

export const hasTokens = (segments: Segment[]): boolean =>
  segments.some((s) => (s.tokens?.length ?? 0) > 0);

/** Um pedaço da fala para desenhar: texto + status (null = não é palavra de conteúdo). */
export interface MarkedSpan {
  text: string;
  status: WordStatus | null;
}

const HANGUL = /[가-힣]/;

/**
 * Corta `target` nos tokens. Em coreano o token cobre só o radical (있 de
 * 있어요, 왔 de 왔어요); sublinhar só ele parece erro de digitação, então a marca
 * se estende até o fim do eojeol (próximo espaço/pontuação), sem invadir o
 * token seguinte. Japonês não tem espaço e o token já é a palavra inteira.
 */
export function markSpans(seg: Segment, status: LemmaStatus | null | undefined): MarkedSpan[] {
  const text = seg.target;
  const toks = seg.tokens ?? [];
  if (!toks.length) return [{ text, status: null }];
  const out: MarkedSpan[] = [];
  let cursor = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.start < cursor) continue; // sobreposição (não deveria): ignora
    let end = t.end;
    const cap = i + 1 < toks.length ? toks[i + 1].start : text.length;
    while (end < cap && HANGUL.test(text[end])) end++;
    if (t.start > cursor) out.push({ text: text.slice(cursor, t.start), status: null });
    out.push({ text: text.slice(t.start, end), status: statusOf(status, t.lemma) });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), status: null });
  return out;
}

/** Quanto de uma lição o aluno já entende, contado por OCORRÊNCIA (o que é dito)
 *  e por palavra distinta. Ocorrência é a medida de compreensão; a distinta diz
 *  quantas palavras faltam. */
export interface Coverage {
  tokens: number;
  known: number;
  learning: number;
  /** ocorrências de palavras nunca estudadas */
  fresh: number;
  lemmas: number;
  lemmasKnown: number;
  lemmasLearning: number;
}

export function coverage(segments: Segment[], status: LemmaStatus | null | undefined): Coverage {
  const cov: Coverage = { tokens: 0, known: 0, learning: 0, fresh: 0, lemmas: 0, lemmasKnown: 0, lemmasLearning: 0 };
  const seen = new Map<string, WordStatus>();
  for (const s of segments) {
    for (const t of s.tokens ?? []) {
      const st = statusOf(status, t.lemma);
      cov.tokens++;
      if (st === "known") cov.known++;
      else if (st === "learning") cov.learning++;
      else cov.fresh++;
      seen.set(t.lemma, st);
    }
  }
  cov.lemmas = seen.size;
  for (const st of seen.values()) {
    if (st === "known") cov.lemmasKnown++;
    else if (st === "learning") cov.lemmasLearning++;
  }
  return cov;
}

/** Fração de ocorrências já fixadas, ou null sem tokens. */
export function knownShare(cov: Coverage): number | null {
  return cov.tokens ? cov.known / cov.tokens : null;
}

export type { SegmentToken };
