// Mirrors pipeline/dose_factory/schema.py and docs/dose-contract.md (schemaVersion 1).

export type MediaKind = "audio" | "video";

/** Faixa de vocabulário: A = TOPIK I, B = TOPIK II 3–4급, C = TOPIK II 5–6급. */
export type TopikTier = "A" | "B" | "C";

/** Um vídeo de origem. Uma dose pode ser montada a partir de mais de um
 *  (as lições A0 emendam 2 histórias curtas), então `parts` lista todos na
 *  ordem em que aparecem no `media.src`. */
export interface SourcePart {
  url: string;
  startMs: number;
  title?: string | null;
}

export interface Source {
  platform: string;
  url?: string | null;
  creator?: string | null;
  creatorHandle?: string | null;
  /** Vazio quando a dose vem de um vídeo só (aí vale `url`). */
  parts?: SourcePart[];
}

export interface Media {
  kind: MediaKind;
  src: string;
  durationSec: number;
  condensedAudioSrc?: string | null;
  posterSrc?: string | null;
}

export interface Difficulty {
  cefr?: string | null;
  comprehensibilityHint?: string | null;
  newVocabCount?: number | null;
}

/** Uma palavra de conteúdo dentro da fala: posição em `target` ([start, end))
 *  e forma de dicionário. `lemma` é a mesma string do id do card (`w-<lemma>`),
 *  então "esta palavra já é card?" é comparar strings (ver `lib/vocab.ts`). */
export interface SegmentToken {
  lemma: string;
  surface: string;
  start: number;
  end: number;
}

export interface Segment {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  target: string;
  translation?: string | null;
  speakerId?: string | null;
  /** Ausente em dose antiga (antes de `dose_factory tokens`): a legenda fica sem
   *  marcação e a lição sem medida de compreensão — nunca um erro. */
  tokens?: SegmentToken[];
}

export interface PrimeChunk {
  id: string;
  startMs: number;
  endMs: number;
  summary: string;
  segmentIds: string[];
}

export interface SentenceCard {
  id: string;
  segmentId: string;
  target: string;
  translation: string;
  startMs: number;
  endMs: number;
  reading?: string | null;
  context?: string | null;
  audioClipSrc?: string | null; // FRONT: word TTS clip
  exampleAudioSrc?: string | null; // BACK: pre-cut example-sentence fragment
  freqRank?: number | null; // rank in the language frequency list (1 = most frequent)
  /** Faixa de vocabulário TOPIK/국립국어원 — a régua de progresso, NÃO o critério de
   *  seleção do card. "A" = TOPIK I (1–2급 · A1–A2), "B" = TOPIK II (3–4급),
   *  "C" = TOPIK II (5–6급). Ver `lib/levels.ts` e `pipeline/dose_factory/levels.py`. */
  topikLevel?: TopikTier | null;
  imageSrc?: string | null;
  /** Quadro do vídeo no momento da frase-exemplo (`dose_factory frames`). A cena
   *  volta no verso do card, ao lado da frase — liga a palavra ao momento em que
   *  foi ouvida. Ausente em dose antiga: o card fica sem imagem, nunca um erro. */
  sceneSrc?: string | null;
  newWords?: string[];
}

export interface VocabItem {
  term: string;
  meaning: string;
  reading?: string | null;
  exampleSegmentId?: string | null;
}

export interface Dose {
  schemaVersion: number;
  id: string;
  language: string;
  languageName: string;
  level: string;
  lessonNumber: number;
  title: string;
  titleTarget?: string | null;
  synopsis: string;
  premise?: string | null;
  source: Source;
  media: Media;
  difficulty: Difficulty;
  segments: Segment[];
  primePreview: PrimeChunk[];
  cards: SentenceCard[];
  vocab?: VocabItem[];
  grammarPoints?: string[];
  tags?: string[];
  createdAt: string;
}

// ---- catalog / course ----

export interface LevelDef {
  id: string;
  name: string;
  description: string;
}

export interface DoseRef {
  id: string;
  level: string;
  lessonNumber: number;
  title: string;
  path: string;
  durationSec: number;
  cardCount: number;
  mediaKind: MediaKind;
  /** Capa (quadro do vídeo), relativa à pasta da dose — copiada de `media.posterSrc`
   *  para a Biblioteca e a trilha do Hoje não precisarem baixar cada dose.json. */
  posterSrc?: string | null;
  /** Quantos cards da dose em cada faixa, ex.: { A: 18, B: 2 }. */
  cardTiers?: Partial<Record<TopikTier, number>>;
}

/** Uma faixa da escada de vocabulário do idioma (o denominador do progresso). */
export interface VocabTier {
  tier: TopikTier;
  name: string;   // "Básico"
  exam: string;   // "TOPIK I · 1–2급"
  cefr: string;   // "A1–A2"
  words: number;  // quantas palavras a faixa tem
}

/** Escada de vocabulário publicada pela pipeline — o app não embute números. */
export interface VocabLadder {
  exam: string;   // "TOPIK"
  source: string;
  tiers: VocabTier[];
}

/** Sem `flag`: idioma se apresenta na própria escrita (한국어 / 日本語), nunca por
 *  bandeira — bandeira é país, não língua, e emoji está fora do sistema visual
 *  (ver docs/design-system.md). O campo não existe no contrato justamente para
 *  não haver o que a UI possa pegar por engano. */
export interface Course {
  schemaVersion: number;
  language: string;
  name: string;
  nativeName: string;
  levels: LevelDef[];
  doses: DoseRef[];
  /** Ausente em idiomas sem tabela de níveis — a UI simplesmente não mostra. */
  vocabLadder?: VocabLadder;
}

/** Ver `Course`: sem `flag`, pelo mesmo motivo. */
export interface LanguageEntry {
  code: string;
  name: string;
  nativeName: string;
  coursePath: string;
  doseCount: number;
}

export interface ContentIndex {
  schemaVersion: number;
  languages: LanguageEntry[];
}
