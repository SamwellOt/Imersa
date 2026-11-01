// Regra pura da sessão de revisão: o item da fila (card + URLs prontas), o tipo
// de cada aparição e as transformações da fila em memória (cards que voltam,
// desfazer, adiar/suspender). Nada aqui lê o banco nem a rede.
import { State } from "ts-fsrs";
import type { Dose, SentenceCard } from "@/types/dose";
import { isLearningState, type QueueEntry } from "@/lib/srs";
import type { CardRecord } from "@/lib/db";
import { mediaUrl as mediaPath } from "@/lib/content";
import { exampleFor } from "@/lib/cards";
import type { ResolvedExample } from "./Flashcard";

export interface ResolvedItem extends QueueEntry {
  /** Id desta APARIÇÃO na fila (um card que volta ganha outro). É a `key` do
   *  `<Flashcard>`: com a chave do card, um card que voltava logo em seguida
   *  (ou o "desfazer" caindo no mesmo card) reaproveitava o componente já
   *  avaliado — botões mortos, verso já aberto. */
  uid: number;
  dose: Dose;
  card: SentenceCard;
  mediaUrl: string; // main dose media (fallback fragment)
  wordAudioUrl?: string; // word TTS clip (front)
  fragmentUrl?: string; // pre-cut example fragment (back)
  sceneUrl?: string; // quadro do vídeo na frase-exemplo (back)
  example?: ResolvedExample; // frase-exemplo (i+1 quando existe), com URLs prontas
}

export type DoseEntry = { dose: Dose; mediaUrl: string; path: string };

/** URLs do card e da frase-exemplo, a partir da dose já resolvida. */
export function assets(language: string, entry: DoseEntry, card: SentenceCard) {
  const url = (rel?: string | null) => (rel ? mediaPath(language, entry.path, rel) : undefined);
  const ex = exampleFor(entry.dose, card);
  return {
    dose: entry.dose,
    card,
    mediaUrl: entry.mediaUrl,
    wordAudioUrl: url(card.audioClipSrc),
    fragmentUrl: url(card.exampleAudioSrc),
    sceneUrl: url(card.sceneSrc),
    example: ex ? { ...ex, audioUrl: url(ex.audioSrc), sceneUrl: url(ex.sceneSrc) } : undefined,
  };
}

export type Kind = "new" | "learning" | "review";

export function kindOf(it: QueueEntry): Kind {
  if (it.isNew || !it.rec || it.rec.state === State.New) return "new";
  return isLearningState(it.rec) ? "learning" : "review";
}

export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 140 ? msg.slice(0, 140) + "…" : msg;
}

/**
 * Insere na fila os cards que voltaram, sem repetir o que já está à frente.
 * `atEnd` = no fim da fila; senão logo depois do card em tela (`pos`).
 * Devolve a MESMA lista quando não há nada a inserir.
 */
export function mergeReturned(
  prev: ResolvedItem[],
  extra: ResolvedItem[],
  pos: number,
  justGraded: string | null,
  atEnd: boolean,
): ResolvedItem[] {
  const at = atEnd ? prev.length : Math.min(pos + 1, prev.length);
  const ahead = new Set(prev.slice(pos).map((it) => it.key));
  const add: ResolvedItem[] = [];
  for (const it of extra) {
    if (ahead.has(it.key)) continue;
    // o que acabou de ser avaliado só volta em seguida se for o único
    if (it.key === justGraded && prev.length > pos) continue;
    ahead.add(it.key);
    add.push(it);
  }
  if (!add.length) return prev;
  return [...prev.slice(0, at), ...add, ...prev.slice(at)];
}

/** Troca o `uid` do item em `i` (remonta o Flashcard). Mesma lista se não há item. */
export function remountAt(prev: ResolvedItem[], i: number, uid: number): ResolvedItem[] {
  if (!prev[i]) return prev;
  const copy = [...prev];
  copy[i] = { ...prev[i], uid };
  return copy;
}

/**
 * Desfazer: o item em `idx` volta com o estado anterior (`prevRec`; `null` =
 * nasceu na nota desfeita → volta como novo). Uma volta dele já enfileirada mais
 * à frente carregava o estado desfeito e sai da fila.
 */
export function rewindAt(prev: ResolvedItem[], idx: number, prevRec: CardRecord | null, uid: number): ResolvedItem[] {
  const it = prev[idx];
  if (!it) return prev;
  const copy = prev.filter((x, i) => i <= idx || x.key !== it.key);
  copy[idx] = { ...it, rec: prevRec ?? undefined, isNew: prevRec == null, uid };
  return copy;
}

/** Tira o card da fila só daqui (`pos`) para a frente — o passado não encolhe. */
export function dropAhead(prev: ResolvedItem[], pos: number, key: string): ResolvedItem[] {
  return prev.filter((it, i) => i < pos || it.key !== key);
}

/** O que ainda falta, por tipo, a partir de `pos`. */
export function countRemaining(items: ResolvedItem[] | null, pos: number): Record<Kind, number> {
  const r = { new: 0, learning: 0, review: 0 };
  if (items) for (const it of items.slice(pos)) r[kindOf(it)]++;
  return r;
}
