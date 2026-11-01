// Dados da sessão de revisão: transforma a fila do SRS (só chaves e registros)
// em itens prontos para a tela, baixando cada dose uma vez. É aqui que um
// registro órfão é apagado — e SÓ quando a dose/card sumiu de verdade.
import type { CardRecord } from "@/lib/db";
import { dropStaleCard, type QueueEntry } from "@/lib/srs";
import { resolveDose, DoseMissingError } from "@/lib/content";
import { findCard } from "@/lib/cards";
import { assets, type DoseEntry, type ResolvedItem } from "./reviewQueue";

/** O que a sessão mantém entre resoluções (vive em refs do componente). */
export interface ResolveCtx {
  language: string;
  /** Doses já baixadas nesta sessão, por id. */
  doseCache: Map<string, DoseEntry>;
  /** Tudo que já passou pela sessão (por chave): atalho para montar um card que
   *  volta sem baixar a dose de novo. */
  seen: Map<string, ResolvedItem>;
  nextUid: () => number;
}

/** Monta o item de um registro (card já visto), pela cache ou baixando a dose. */
export async function resolveRecord(ctx: ResolveCtx, rec: CardRecord): Promise<ResolvedItem | null> {
  const base = ctx.seen.get(rec.key);
  if (base) return { ...base, rec, isNew: false, uid: ctx.nextUid() };
  let entry = ctx.doseCache.get(rec.doseId);
  if (!entry) {
    try {
      const r = await resolveDose(ctx.language, rec.doseId);
      entry = { dose: r.dose, mediaUrl: r.mediaUrl, path: r.path };
      ctx.doseCache.set(rec.doseId, entry);
    } catch {
      return null; // sem rede e sem cache: fica para a próxima conferência
    }
  }
  const card = findCard(entry.dose, rec.cardId);
  if (!card) return null;
  const item: ResolvedItem = {
    key: rec.key, doseId: rec.doseId, cardId: rec.cardId, isNew: false, rec, uid: ctx.nextUid(),
    ...assets(ctx.language, entry, card),
  };
  ctx.seen.set(item.key, item);
  return item;
}

/**
 * Resolve a fila montada pelo SRS. Registro órfão só é apagado quando a
 * dose/card REALMENTE sumiu do conteúdo. Falha de rede apenas tira o card desta
 * fila — o app é offline-first, e apagar aqui significaria perder o progresso do
 * aluno (e propagar a perda para os outros aparelhos na sincronização).
 */
export async function resolveQueue(ctx: ResolveCtx, q: QueueEntry[]): Promise<ResolvedItem[]> {
  const { language, doseCache } = ctx;
  const resolved: ResolvedItem[] = [];
  const fetchEntry = async (doseId: string, fresh = false) => {
    const r = await resolveDose(language, doseId, fresh);
    const entry = { dose: r.dose, mediaUrl: r.mediaUrl, path: r.path };
    doseCache.set(doseId, entry);
    return entry;
  };
  /**
   * "Sumiu" segundo a cópia em cache não basta: o `course.json` guardado
   * pelo service worker (e o desta sessão) pode ser de antes de a dose
   * existir — os cards que o outro aparelho estudou nela chegavam pela
   * sincronização e eram apagados aqui, com tombstone, na primeira
   * abertura da revisão. Só a resposta fresca do servidor decide.
   */
  const confirmGone = async (it: QueueEntry): Promise<boolean> => {
    try {
      const fresh = await fetchEntry(it.doseId, true);
      return !findCard(fresh.dose, it.cardId);
    } catch (err) {
      return err instanceof DoseMissingError;
    }
  };
  for (const it of q) {
    let entry = doseCache.get(it.doseId);
    if (!entry) {
      try {
        entry = await fetchEntry(it.doseId);
      } catch (err) {
        if (it.rec && err instanceof DoseMissingError && (await confirmGone(it))) {
          await dropStaleCard(it.key);
        }
        continue;
      }
    }
    let card = findCard(entry.dose, it.cardId);
    if (!card && it.rec) {
      // card id sumiu da dose em cache: a dose fresca pode tê-lo (build novo)
      if (await confirmGone(it)) {
        await dropStaleCard(it.key); // card id no longer exists → self-heal
        continue;
      }
      entry = doseCache.get(it.doseId) ?? entry;
      card = findCard(entry.dose, it.cardId);
    }
    if (!card) continue;
    const item: ResolvedItem = { ...it, uid: ctx.nextUid(), ...assets(language, entry, card) };
    ctx.seen.set(item.key, item);
    resolved.push(item);
  }
  return resolved;
}
