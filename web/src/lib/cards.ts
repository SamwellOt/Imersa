// Onde mora cada card dentro de uma dose. Além dos 20 cards de palavra
// (`dose.cards`) existem os cards de frase i+1 (`dose.sentenceCards`) e as
// palavras do glossário que o aluno transformou em card ("+ card",
// `glossary[].card`). Toda busca de card por id passa por aqui: a revisão que
// procurava só em `dose.cards` tomaria um card de frase por órfão — e o apagaria.
import type { Dose, GlossEntry, Segment, SentenceCard } from "@/types/dose";

export const WORD_PREFIX = "w-";
export const SENTENCE_PREFIX = "s-";

export const isSentenceCard = (c: Pick<SentenceCard, "id" | "kind">): boolean =>
  c.kind === "sentence" || c.id.startsWith(SENTENCE_PREFIX);

export function findCard(dose: Dose, cardId: string): SentenceCard | undefined {
  return (
    dose.cards.find((c) => c.id === cardId) ??
    dose.sentenceCards?.find((c) => c.id === cardId) ??
    dose.glossary?.find((g) => g.card?.id === cardId)?.card ??
    undefined
  );
}

/** Entrada de dicionário de um lema nesta dose: card da própria dose ou glossário. */
export interface LemmaInfo {
  lemma: string;
  target: string;
  reading?: string | null;
  meaning?: string | null;
  meaningEn?: string | null;
  freqRank?: number | null;
  base?: boolean;
  /** Card desta dose (um dos 20) — o SRS já cuida dele. */
  doseCard?: SentenceCard;
  /** Pode virar card ("+ card"). */
  addable?: SentenceCard;
  /** É card de outra lição do curso. */
  cardIn?: string | null;
  /** Só dicionário: nunca vira card (gramática, nome, número). */
  dict?: boolean;
}

export function lemmaInfo(dose: Dose, lemma: string): LemmaInfo | null {
  const card = dose.cards.find((c) => c.id === WORD_PREFIX + lemma);
  if (card) {
    return {
      lemma, target: card.target, reading: card.reading, meaning: card.translation,
      freqRank: card.freqRank, doseCard: card,
    };
  }
  const g: GlossEntry | undefined = dose.glossary?.find((e) => e.lemma === lemma);
  if (!g) return null;
  return {
    lemma, target: g.target, reading: g.reading, meaning: g.meaning, meaningEn: g.meaningEn,
    freqRank: g.freqRank, base: g.base, addable: g.card ?? undefined, cardIn: g.cardIn, dict: g.dict,
  };
}

/**
 * Frase-exemplo de um card de palavra, com a posição da palavra nela. Prefere a
 * frase **i+1** da dose (`sentenceCards` cujo foco é esta palavra: todas as
 * outras palavras já conhecidas); sem ela, a frase-exemplo do próprio card
 * (`context`, a mais curta da lição que contém a palavra). Card de frase não
 * tem exemplo — ele já é a frase.
 */
export interface CardExample {
  target: string;
  translation: string;
  /** Trecho da palavra em `target` (`start < 0` = não localizada). */
  start: number;
  end: number;
  /** Áudio da frase (fragmento pré-cortado), relativo à pasta da dose. */
  audioSrc?: string | null;
  sceneSrc?: string | null;
  startMs: number;
}

const HANGUL = /[가-힣]/;

/** Localiza a palavra na frase pelos tokens da legenda (o lema, não a grafia:
 *  いい → 良い, 있다 → 있어요); sem token, pela grafia. */
function locate(dose: Dose, sentence: string, lemma: string, surface: string): [number, number] {
  const seg: Segment | undefined = dose.segments.find((s) => s.target.trim() === sentence.trim());
  const tok = seg?.tokens?.find((t) => t.lemma === lemma);
  if (seg && tok) {
    const off = seg.target.indexOf(sentence.trim()) >= 0 ? seg.target.indexOf(sentence.trim()) : 0;
    let end = tok.end;
    // coreano: o token é só o radical (있 de 있어요) — a marca vai até o fim do eojeol
    while (end < seg.target.length && HANGUL.test(seg.target[end])) end++;
    return [tok.start - off, end - off];
  }
  const i = surface ? sentence.indexOf(surface) : -1;
  return i >= 0 ? [i, i + surface.length] : [-1, -1];
}

export function exampleFor(dose: Dose, card: SentenceCard): CardExample | null {
  if (isSentenceCard(card) || !card.id.startsWith(WORD_PREFIX)) return null;
  const lemma = card.id.slice(WORD_PREFIX.length);
  const i1 = dose.sentenceCards?.find((s) => s.focus && s.focus.lemma === lemma);
  if (i1?.focus && i1.focus.end <= i1.target.length) {
    return {
      target: i1.target, translation: i1.translation, start: i1.focus.start, end: i1.focus.end,
      audioSrc: i1.audioClipSrc ?? i1.exampleAudioSrc, sceneSrc: i1.sceneSrc, startMs: i1.startMs,
    };
  }
  if (!card.context) return null;
  const sep = card.context.indexOf(" — ");
  const sentence = sep >= 0 ? card.context.slice(0, sep) : card.context;
  const [start, end] = locate(dose, sentence, lemma, card.newWords?.[0] || card.target);
  return {
    target: sentence, translation: sep >= 0 ? card.context.slice(sep + 3) : "", start, end,
    audioSrc: card.exampleAudioSrc, sceneSrc: card.sceneSrc, startMs: card.startMs,
  };
}
