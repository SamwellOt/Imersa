// Nível de evolução do aluno, medido contra a escada de vocabulário do idioma
// (TOPIK, no coreano). É só régua: não muda o que a dose ensina nem a ordem dos
// cards — serve para responder "onde eu estou e quanto falta".
//
// O denominador vem do `course.json` (`vocabLadder`), publicado pela pipeline, e
// não de números embutidos aqui: trocar a lista de referência é mudar um arquivo
// de dados, não o app.
import { db, type CardRecord } from "./db";
import { loadDose } from "./content";
import { scheduleSync } from "./sync";
import type { Course, TopikTier, VocabTier } from "@/types/dose";

/** Uma palavra só conta como sabida quando o FSRS a considera em revisão. */
const STATE_REVIEW = 2;

export interface TierProgress extends VocabTier {
  /** Palavras da faixa já fixadas (estado "revisão" no FSRS). */
  known: number;
  /** Vistas ao menos uma vez, mas ainda em aprendizado. */
  learning: number;
  /** Quantas o curso já publicou nessa faixa (o teto do que dá para aprender hoje). */
  available: number;
}

export interface LevelProgress {
  exam: string;
  source: string;
  tiers: TierProgress[];
  /** A faixa em que o aluno está agora (a primeira ainda não completa). */
  current: TierProgress;
  knownTotal: number;
  learningTotal: number;
}

/**
 * Preenche `topikLevel` em registros antigos (criados antes de o campo existir).
 * Sem isso, quem já estudava veria o progresso zerado — o dado está no
 * `dose.json`, só não tinha sido copiado para o registro local.
 */
export async function backfillCardTiers(course: Course): Promise<void> {
  // Só o idioma do curso: card de outro idioma (sem tabela) ficaria
  // `undefined` para sempre e esta função refaria o mesmo trabalho a cada abertura.
  const missing = await db.cards
    .where("language").equals(course.language)
    .filter((c) => c.topikLevel === undefined)
    .toArray();
  if (!missing.length) return;
  const byDose = new Map<string, CardRecord[]>();
  for (const c of missing) {
    const arr = byDose.get(c.doseId);
    if (arr) arr.push(c);
    else byDose.set(c.doseId, [c]);
  }
  let wrote = false;
  for (const [doseId, recs] of byDose) {
    const ref = course.doses.find((d) => d.id === doseId);
    if (!ref) continue;
    try {
      const dose = await loadDose(course.language, ref.path);
      const tierOf = new Map(dose.cards.map((c) => [c.id, c.topikLevel ?? null]));
      // `updatedAt` novo: card é ESTADO, e escrita sem tocar no carimbo perde o
      // last-write-wins — o backfill nunca viajava para o outro aparelho e
      // ainda era desfeito pela primeira escrita que chegasse de lá.
      const now = Date.now();
      await db.cards.bulkPut(
        recs.map((r) => ({ ...r, topikLevel: tierOf.get(r.cardId) ?? null, updatedAt: now })),
      );
      wrote = true;
    } catch {
      /* dose indisponível (offline): tenta de novo na próxima vez */
    }
  }
  if (wrote) scheduleSync();
}

/** Onde o aluno está na escada — ou `null` se o idioma não tem tabela. */
export async function getLevelProgress(
  language: string,
  course: Course,
): Promise<LevelProgress | null> {
  const ladder = course.vocabLadder;
  if (!ladder?.tiers?.length) return null;

  await backfillCardTiers(course);
  const cards = await db.cards.where("language").equals(language).toArray();

  // teto do que o curso oferece hoje, somando as faixas de cada dose
  const published = new Map<TopikTier, number>();
  for (const d of course.doses) {
    for (const [tier, n] of Object.entries(d.cardTiers ?? {})) {
      published.set(tier as TopikTier, (published.get(tier as TopikTier) ?? 0) + (n ?? 0));
    }
  }

  const tiers: TierProgress[] = ladder.tiers.map((t) => {
    const mine = cards.filter((c) => c.topikLevel === t.tier);
    return {
      ...t,
      known: mine.filter((c) => c.state === STATE_REVIEW).length,
      learning: mine.filter((c) => c.state !== STATE_REVIEW).length,
      available: published.get(t.tier) ?? 0,
    };
  });

  const current = tiers.find((t) => t.known < t.words) ?? tiers[tiers.length - 1];
  return {
    exam: ladder.exam,
    source: ladder.source,
    tiers,
    current,
    knownTotal: tiers.reduce((a, t) => a + t.known, 0),
    learningTotal: tiers.reduce((a, t) => a + t.learning, 0),
  };
}

/**
 * Quantos dias de estudo faltam para fechar a faixa, no ritmo de `perDay`
 * palavras novas — contando só o que o curso já tem publicado, porque prometer
 * data com base em conteúdo que ainda não existe seria mentira.
 */
export function daysToFinish(t: TierProgress, perDay: number): number | null {
  if (perDay <= 0) return null;
  const reachable = Math.min(t.words, t.available);
  const left = reachable - t.known;
  return left > 0 ? Math.ceil(left / perDay) : 0;
}
