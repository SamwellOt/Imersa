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
  /** Áudio condensado (`dose_factory enrich`): só as falas, emendadas — para
   *  ouvir de novo a lição (e offline). */
  condensedAudioSrc?: string | null;
  /** `[[inícioCondensado, inícioOriginal, duração], …]` em ms: é por ele que a
   *  escuta acha a legenda de cada instante do áudio condensado. */
  condensedMap?: [number, number, number][];
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
  /** Palavra da base que o aluno já sabe (as N mais frequentes do idioma — no
   *  japonês, as 1000 primeiras). Conta como conhecida sem precisar de card. */
  base?: boolean;
  /** Só dicionário: palavra que nunca vira card (人, 私, この, はい, nomes,
   *  números; 저, 그리고, 시, 이다). Toca e abre o dicionário, mas fica FORA da
   *  compreensão, das marcas "conhecido/novo" e do Prime adaptativo. */
  dict?: boolean;
  /** Nome próprio (só em token `dict`): pessoa, lugar ou outro. */
  proper?: "person" | "place" | "name";
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
  /** Japonês: outras palavras frequentes com a MESMA pronúncia (使用 · 仕様 · 私用).
   *  Com a frente só em áudio o card seria ambíguo — então a escrita aparece junto. */
  homophones?: string[] | null;
  /** "sentence" = card de escuta de uma frase i+1 (`Dose.sentenceCards`): a frente
   *  toca a frase, o verso mostra texto + tradução. Ausente = card de palavra. */
  kind?: "word" | "sentence" | null;
  /** Card de frase: a palavra nova dela (card desta dose) e a posição em `target`. */
  focus?: SentenceFocus | null;
}

export interface SentenceFocus {
  lemma: string;
  target: string;
  meaning?: string | null;
  reading?: string | null;
  start: number;
  end: number;
}

/**
 * Uma palavra da fala no dicionário da dose (`dose_factory enrich`): é o que
 * aparece ao tocar numa palavra da legenda. Cobre toda palavra de conteúdo que
 * não é card desta dose.
 */
export interface GlossEntry {
  lemma: string;
  /** Grafia (forma de dicionário como foi dita). */
  target: string;
  reading?: string | null;
  /** Significado em PT (curado). */
  meaning?: string | null;
  /** Reserva em inglês (JMdict / Wiktionary) quando não há PT. */
  meaningEn?: string | null;
  freqRank?: number | null;
  topikLevel?: TopikTier | null;
  /** Da base que o aluno já sabe (conta como conhecida sem card). */
  base?: boolean;
  /** Card de outra lição do curso (id da dose): não oferece "+ card" aqui. */
  cardIn?: string | null;
  /** Palavra só de dicionário (ver `SegmentToken.dict`): sem "+ card" nem «já sei». */
  dict?: boolean;
  /** Material para virar card ("+ card"): só palavra nova, com PT. */
  card?: SentenceCard | null;
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
  /** Dicionário da legenda (toque na palavra, "+ card"). Ausente em dose antiga. */
  glossary?: GlossEntry[];
  /** Até 5 cards de escuta de frases i+1 (todas as palavras conhecidas menos uma,
   *  que é card desta dose). */
  sentenceCards?: SentenceCard[];
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
  /** Áudio condensado da dose (copiado de `media`): a Biblioteca oferece "ouvir". */
  condensedAudioSrc?: string | null;
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
