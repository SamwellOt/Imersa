// Montagem de fila do SRS — regra pura (nada de banco): recebe os registros já
// lidos e devolve a fila na ordem do Anki. Quem lê o Dexie e chama isto é o
// `srsRepo.ts` (`buildDoseQueue` / `buildDueQueue` / `getTodayCounts`).
import { State } from "ts-fsrs";
import type { Dose } from "@/types/dose";
import { WORD_PREFIX } from "./cards";
import type { CardRecord, ReviewRecord } from "./db";
import { dayKey } from "./utils";
import { cardKey, hiddenBySettings, isActive, isLearningState, scheduler, toFsrs, type SrsSettings } from "./srsCore";

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

/** Contadores do dia a partir das notas de HOJE (já filtradas por idioma). */
export function countToday(todays: ReviewRecord[]): TodayCounts {
  return {
    reviewsDone: todays.length,
    // card extra ("+ card") e de frase não gastam a cota dos 20 da dose
    newIntroduced: todays.filter((r) => r.state === State.New && !r.origin).length,
    reviewCardsDone: todays.filter((r) => r.state === State.Review).length,
  };
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
export function assemble(
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
 * Fila da fase "Revisão" da dose, a partir do que já foi lido do banco:
 * `mineAll` = registros desta dose; `langRecs` = registros do idioma inteiro;
 * `newIntroduced` = palavras novas já avaliadas hoje.
 */
export function planDoseQueue(
  dose: Dose,
  mineAll: CardRecord[],
  langRecs: CardRecord[],
  newIntroduced: number,
  s: SrsSettings,
  now: number,
): DoseQueue {
  const existingKeys = new Set(mineAll.map((c) => c.key));
  const mine = mineAll.filter((c) => isActive(c, now) && !hiddenBySettings(c, s));
  // Palavra que já tem registro em QUALQUER lição do idioma (virou "+ card" na
  // legenda de outra dose, ou foi marcada «já sei») não volta como nova aqui.
  const wordsSeen = new Set(langRecs.filter((r) => r.cardId.startsWith(WORD_PREFIX)).map((r) => r.cardId));

  const allowance = Math.max(0, s.newPerDay - newIntroduced);
  const unseen = dose.cards.filter(
    (c) => !existingKeys.has(cardKey(dose.id, c.id)) && !wordsSeen.has(c.id),
  );
  const news: QueueEntry[] = unseen
    .slice(0, allowance)
    .map((c) => ({ key: cardKey(dose.id, c.id), doseId: dose.id, cardId: c.id, isNew: true }));
  // Frase i+1 só depois que a palavra nova dela já foi vista (numa sessão
  // anterior): ouvir a palavra de novo, noutro contexto, é o ponto do card.
  // Palavra marcada «já sei» não precisa do reencontro: a frase dela fica de fora.
  if (s.sentenceCards) {
    const studying = new Set(
      langRecs.filter((r) => r.cardId.startsWith(WORD_PREFIX) && !r.known).map((r) => r.cardId),
    );
    for (const c of dose.sentenceCards ?? []) {
      const key = cardKey(dose.id, c.id);
      if (existingKeys.has(key) || !c.focus || !studying.has(WORD_PREFIX + c.focus.lemma)) continue;
      news.push({ key, doseId: dose.id, cardId: c.id, isNew: true });
    }
  }

  return { entries: assemble(mine, news, s, now), heldBack: unseen.length - Math.min(unseen.length, allowance) };
}

/**
 * Fila da revisão avulsa a partir dos cards ATIVOS do idioma e das notas em
 * revisão já dadas hoje (o teto de revisões é do dia, não da sessão).
 */
export function planDueQueue(
  active: CardRecord[],
  reviewCardsDone: number,
  s: SrsSettings,
  now: number,
): QueueEntry[] {
  const allowance = Math.max(0, s.maxReviewsPerDay - reviewCardsDone);
  const learning = active.filter((c) => isLearningState(c));
  const reviews = active
    .filter((c) => !isLearningState(c) && c.due <= now)
    .sort((a, b) => a.due - b.due)
    .slice(0, allowance);
  return assemble([...learning, ...reviews], [], s, now);
}
