// Acesso a dados do SRS: tudo o que lê/grava o Dexie (cards, reviewLog,
// immersionLog, settings, tombstones) e agenda a sincronização. As decisões
// moram em `srsCore.ts` (regra) e `srsQueue.ts` (montagem de fila); a API
// pública continua sendo `srs.ts`, que reexporta daqui.
import {
  createEmptyCard,
} from "ts-fsrs";
import type { Dose, SentenceCard } from "@/types/dose";
import { isSentenceCard } from "./cards";
import {
  db,
  getSetting,
  newUid,
  setSetting,
  tombstone,
  type CardRecord,
} from "./db";
import { scheduleSync } from "./sync";
import { dayKey, nextDayStart } from "./utils";
import {
  normalizeSettings, scheduler, toFsrs, applyFsrs, cardKey, isActive, isLearningState, availableAt,
  hiddenBySettings, previewFrom, applyGrade, freshRecord, replayHistory,
  type ReviewRating, type SrsSettings, type GradeResult,
} from "./srsCore";
import { countToday, planDoseQueue, planDueQueue, type DoseQueue, type QueueEntry, type TodayCounts } from "./srsQueue";



export async function getSrsSettings(): Promise<SrsSettings> {
  return normalizeSettings(await getSetting<Partial<SrsSettings> | null>("srs", null));
}

/**
 * Grava um ajuste do SRS por cima do que está NO BANCO (não de um snapshot da
 * tela): um `srs` que chegou pela sincronização (parâmetros otimizados em outro
 * aparelho) não pode ser sobrescrito pelo patch de um ajuste. Ler e gravar na
 * mesma transação: dois toques rápidos não perdem um ajuste.
 */
export async function saveSrsSettings(patch: Partial<SrsSettings>): Promise<SrsSettings> {
  return db.transaction("rw", db.settings, async () => {
    const merged = { ...(await getSrsSettings()), ...patch };
    await setSetting("srs", merged);
    return merged;
  });
}

/** O registro como está no banco AGORA (ou `fallback`, se ele não existe mais). */
export async function freshCard(key: string, fallback: CardRecord): Promise<CardRecord> {
  return (await db.cards.get(key)) ?? fallback;
}

/** Apaga um card órfão (a dose ou o card sumiu do conteúdo), com tombstone. */
export async function dropStaleCard(key: string): Promise<void> {
  await db.cards.delete(key);
  await tombstone("card", key);
}

/** Total de notas dadas no idioma (o piso do otimizador é contado daqui). */
export function countReviews(language: string): Promise<number> {
  return db.reviewLog.where("language").equals(language).count();
}


async function activeCards(language: string, now = Date.now(), settings?: SrsSettings): Promise<CardRecord[]> {
  const s = settings ?? (await getSrsSettings());
  return (await db.cards.where("language").equals(language).toArray())
    .filter((c) => isActive(c, now) && !hiddenBySettings(c, s));
}

// ---- daily counters ----

export async function getTodayCounts(language: string): Promise<TodayCounts> {
  // Counted from actual GRADES today — a card only counts once it's been rated.
  const today = dayKey();
  // pelo índice do dia: o log inteiro do idioma cresce para sempre e isto roda
  // a cada montagem de fila e a cada lição no Hoje
  const todays = await db.reviewLog.where("day").equals(today).filter((r) => r.language === language).toArray();
  return countToday(todays);
}

/**
 * Imersão entra como EVENTO, não como contador. Dois aparelhos no mesmo dia
 * somam; um contador sincronizado por last-write-wins perderia o tempo do outro.
 */
export async function logImmersion(language: string, ms: number, doseId?: string): Promise<void> {
  if (ms <= 0) return;
  const now = Date.now();
  await db.immersionLog.add({
    uid: newUid(), language, day: dayKey(new Date(now)), ms, at: now,
    ...(doseId ? { doseId } : {}),
  });
  scheduleSync();
}

// ---- queue building ----

/**
 * Fila da fase "Revisão" **da dose** — escopo fechado nas palavras dela:
 * as ainda não vistas (dentro do teto diário) + as desta mesma dose que
 * venceram. Vencidos de *outras* doses ficam para a revisão avulsa (`/review`);
 * antes eles entravam aqui e a fase virava "1 de 220" em vez de "1 de 20",
 * transformando o fecho da lição numa maratona.
 */
export async function buildDoseQueue(dose: Dose, settings?: SrsSettings): Promise<DoseQueue> {
  const s = settings ?? (await getSrsSettings());
  const now = Date.now();
  const mineAll = await db.cards.where("doseId").equals(dose.id).toArray();
  const langRecs = await db.cards.where("language").equals(dose.language).toArray();
  const { newIntroduced } = await getTodayCounts(dose.language);
  return planDoseQueue(dose, mineAll, langRecs, newIntroduced, s, now);
}

/** Standalone review: only already-seen cards due now (new cards come from doses). */
export async function buildDueQueue(language: string, settings?: SrsSettings): Promise<QueueEntry[]> {
  const s = settings ?? (await getSrsSettings());
  const now = Date.now();
  const active = await activeCards(language, now, s);
  // Teto de revisões do dia, contado do log (não por sessão): abrir a tela
  // três vezes não triplica o teto. Aprendizado não conta, como no Anki.
  const { reviewCardsDone } = await getTodayCounts(language);
  return planDueQueue(active, reviewCardsDone, s, now);
}

/** Onde uma sessão de revisão busca os cards que voltam: a dose (fase da dose) ou
 *  o idioma inteiro (revisão avulsa). */
export type QueueScope = { language: string; doseId?: string };

/**
 * Cards **em (re)aprendizado** do escopo que estão vencidos agora — ou, com
 * `aheadMin`, que vencem até daqui a tantos minutos. É o "voltar para a fila"
 * do Anki: um "De novo" retorna em ~1 min no meio da sessão, e no fim dela os
 * que faltam poucos minutos entram adiantados em vez de deixar o aluno esperando.
 *
 * O escopo vem do BANCO, não de uma lista guardada em memória pela sessão: uma
 * recarga da página (ou a aba descartada pelo celular) no meio da lição
 * perdia essa lista, o learn-ahead trazia só o que foi avaliado depois e a
 * dose fechava com quase todos os cards ainda em aprendizado.
 */
export async function dueLearning(
  scope: QueueScope,
  aheadMin = 0,
  now = Date.now(),
): Promise<CardRecord[]> {
  const cutoff = now + aheadMin * 60_000;
  const s = await getSrsSettings();
  const recs = scope.doseId
    ? await db.cards.where("doseId").equals(scope.doseId).toArray()
    : await db.cards.where("language").equals(scope.language).toArray();
  return recs
    .filter((r) => isLearningState(r) && isActive(r, now) && !hiddenBySettings(r, s) && r.due <= cutoff)
    .sort((a, b) => a.due - b.due);
}

/**
 * Quando o próximo card ainda não vencido vence (epoch ms), ou `null` se não há
 * nenhum agendado. É o que permite acordar a UI na hora certa em vez de ficar
 * varrendo o banco de segundo em segundo.
 */
export async function nextDueAt(language: string): Promise<number | null> {
  const now = Date.now();
  const s = await getSrsSettings();
  const future = (await db.cards.where("language").equals(language).toArray())
    .filter((c) => !c.suspended && !c.known && !hiddenBySettings(c, s) && availableAt(c) > now)
    .map(availableAt);
  return future.length ? Math.min(...future) : null;
}

/** Vencidos do idioma que **não** pertencem a esta dose — o resto do dia. */
export async function countDueElsewhere(language: string, doseId: string): Promise<number> {
  const now = Date.now();
  return (await activeCards(language, now)).filter((c) => c.due <= now && c.doseId !== doseId).length;
}

/** Cards já vistos que estão vencidos agora (dashboard / badge da navegação). */
/** O card vencido há mais tempo (para o Hoje mostrar "o mais atrasado"). */
export async function mostOverdue(language: string): Promise<CardRecord | null> {
  const now = Date.now();
  const due = (await activeCards(language, now)).filter((c) => c.due <= now);
  if (!due.length) return null;
  return due.reduce((a, c) => (c.due < a.due ? c : a));
}

/**
 * Cards em (re)aprendizado que ainda não venceram mas entram na revisão avulsa
 * pelo "learn ahead" (vencem em até `learnAheadMin`). O Hoje dizia "0 vencidos"
 * enquanto /review abria com 6 cards — este número explica a diferença.
 */
export async function countLearnAhead(language: string, settings?: SrsSettings): Promise<number> {
  const s = settings ?? (await getSrsSettings());
  const now = Date.now();
  const cutoff = now + s.learnAheadMin * 60_000;
  return (await activeCards(language, now, s)).filter(
    (c) => isLearningState(c) && c.due > now && c.due <= cutoff,
  ).length;
}

export async function countDue(language: string): Promise<number> {
  const now = Date.now();
  return (await activeCards(language, now)).filter((c) => c.due <= now).length;
}

/**
 * Quantas palavras novas desta dose ainda podem entrar hoje = palavras nunca
 * vistas, limitadas pelo que sobrou do teto diário. Usa `cardCount` do `DoseRef`
 * para não precisar baixar o `dose.json` inteiro no dashboard.
 */
export async function countNewReady(
  doseId: string,
  language: string,
  cardCount: number,
  settings?: SrsSettings,
): Promise<number> {
  const s = settings ?? (await getSrsSettings());
  // só os 20 da dose: "+ card" e cards de frase moram na mesma dose, mas não
  // fazem parte do `cardCount` — contá-los escondia palavras novas no Hoje
  const seen = await db.cards.where("doseId").equals(doseId).filter((c) => !c.origin).count();
  const unseen = Math.max(0, cardCount - seen);
  const { newIntroduced } = await getTodayCounts(language);
  return Math.min(unseen, Math.max(0, s.newPerDay - newIntroduced));
}

// ---- grading ----

export async function previewIntervals(rec: CardRecord, settings?: SrsSettings) {
  return previewFrom(toFsrs(rec, Date.now()), settings ?? (await getSrsSettings()));
}

/** Interval preview for an unseen card (before it has a record). */
export async function previewNewIntervals(settings?: SrsSettings) {
  return previewFrom(createEmptyCard(new Date()), settings ?? (await getSrsSettings()));
}

export async function gradeCard(
  rec: CardRecord,
  rating: ReviewRating,
  elapsedMs: number,
  settings?: SrsSettings,
): Promise<GradeResult> {
  const s = settings ?? (await getSrsSettings());
  const now = new Date();
  const { fresh, updated, logEntry } = await db.transaction("rw", [db.cards, db.reviewLog], async () => {
    // o registro do chamador pode estar velho (outra nota, outro aparelho)
    const fresh = (await db.cards.get(rec.key)) ?? rec;
    const { updated, logEntry } = applyGrade(fresh, rating, elapsedMs, s, now);
    await db.cards.put(updated);
    await db.reviewLog.add(logEntry);
    return { fresh, updated, logEntry };
  });
  scheduleSync();
  return { rec: updated, prev: fresh, reviewUid: logEntry.uid, wasNew: false, language: fresh.language };
}

/** First grade of an unseen card: creates its record (this is when it "counts"). */
export async function gradeNew(
  dose: Dose,
  card: SentenceCard,
  rating: ReviewRating,
  elapsedMs: number,
  settings?: SrsSettings,
): Promise<GradeResult> {
  const s = settings ?? (await getSrsSettings());
  const key = cardKey(dose.id, card.id);
  const now = new Date();
  const origin = isSentenceCard(card) ? ("sentence" as const) : undefined;
  const result = await db.transaction("rw", [db.cards, db.reviewLog], async () => {
    // A palavra já tem registro (outro aparelho avaliou antes de sincronizar, ou
    // a fila foi montada antes de a sincronização chegar)? Então isto é uma
    // revisão, não uma estreia: sobrescrever o registro apagaria o estado FSRS
    // de lá e a cota de novos seria cobrada duas vezes.
    const existing = await db.cards.get(key);
    if (existing) {
      const { updated, logEntry } = applyGrade(existing, rating, elapsedMs, s, now);
      await db.cards.put(updated);
      await db.reviewLog.add(logEntry);
      return { rec: updated, prev: existing, reviewUid: logEntry.uid, wasNew: false };
    }
    const base: CardRecord = {
      ...freshRecord(dose, card, now.getTime()),
      ...(origin ? { origin } : {}),
    };
    const { updated, logEntry } = applyGrade(base, rating, elapsedMs, s, now);
    await db.cards.put(updated);
    await db.reviewLog.add(logEntry);
    return { rec: updated, prev: null, reviewUid: logEntry.uid, wasNew: true };
  });
  scheduleSync();
  return { ...result, language: dose.language };
}

/**
 * Desfaz a última avaliação: restaura o estado FSRS anterior (ou apaga o card,
 * se ele só existia por causa dessa nota) e remove o evento do log. Os
 * contadores do dia são derivados do log, então se corrigem sozinhos.
 * Sem isso, um clique errado é permanente.
 */
export async function undoGrade(g: GradeResult): Promise<void> {
  await db.transaction("rw", [db.cards, db.reviewLog, db.tombstones], async () => {
    if (g.prev) {
      await db.cards.put({ ...g.prev, updatedAt: Date.now() });
    } else {
      await db.cards.delete(g.rec.key);
      await tombstone("card", g.rec.key);
    }
    if (g.reviewUid) {  // «já sei» não gera nota
      await db.reviewLog.delete(g.reviewUid);
      await tombstone("review", g.reviewUid);
    }
  });
  scheduleSync();
}

// ---- «já sei» e "+ card" ----

/**
 * «Já sei»: a palavra nunca entra em fila, conta como conhecida (legenda,
 * compreensão, nível) e não gasta a cota do dia. Se ela já tinha registro (outra
 * lição), é ESSE registro que recebe a marca — um card por palavra.
 */
export async function markKnown(dose: Dose, card: SentenceCard): Promise<GradeResult> {
  const now = Date.now();
  const { rec, prev } = await db.transaction("rw", [db.cards], async () => {
    // cursor que para no primeiro achado — não materializa o idioma inteiro
    const lemmaKey = await db.cards.where("language").equals(dose.language)
      .filter((r) => r.cardId === card.id).first();
    const prev = lemmaKey ?? (await db.cards.get(cardKey(dose.id, card.id))) ?? null;
    const rec: CardRecord = { ...(prev ?? freshRecord(dose, card, now)), known: true, updatedAt: now };
    await db.cards.put(rec);
    return { rec, prev };
  });
  scheduleSync();
  return { rec, prev, reviewUid: "", wasNew: prev == null, language: dose.language };
}

/**
 * Desfaz o «já sei»: a palavra volta a ser nova (ou ao estado FSRS que tinha).
 * Card "+ card" (`origin: "extra"`) fica, só sai do «já sei»: foi pedido de propósito.
 */
export async function unmarkKnown(rec: CardRecord): Promise<void> {
  await db.transaction("rw", [db.cards, db.tombstones], async () => {
    const fresh = (await db.cards.get(rec.key)) ?? rec;
    if (fresh.reps > 0 || fresh.origin === "extra") {
      await db.cards.put({ ...fresh, known: false, updatedAt: Date.now() });
    } else {
      await db.cards.delete(fresh.key);
      await tombstone("card", fresh.key);
    }
  });
  scheduleSync();
}

/** Palavras marcadas «já sei» no idioma. */
export async function listKnown(language: string): Promise<CardRecord[]> {
  return (await db.cards.where("language").equals(language).toArray()).filter((c) => c.known);
}

/**
 * "+ card": a palavra da legenda entra no SRS desta dose como card novo, já
 * vencido — aparece na próxima revisão (da dose, ou a avulsa). Não conta no teto
 * de palavras novas do dia: foi o aluno que escolheu.
 */
export async function addExtraCard(dose: Dose, card: SentenceCard): Promise<CardRecord> {
  const now = Date.now();
  const { rec, created } = await db.transaction("rw", [db.cards], async () => {
    // cursor que para no primeiro achado — não materializa o idioma inteiro
    const existing = await db.cards.where("language").equals(dose.language)
      .filter((r) => r.cardId === card.id).first();
    if (existing) return { rec: existing, created: false };
    const rec: CardRecord = { ...freshRecord(dose, card, now), origin: "extra" };
    await db.cards.put(rec);
    return { rec, created: true };
  });
  if (created) scheduleSync();
  return rec;
}

// ---- card actions (Anki: bury / suspend / forget) ----

/** Adia o card até o próximo dia de estudo (Anki "bury"). */
export async function buryCard(rec: CardRecord): Promise<CardRecord> {
  const updated = await db.transaction("rw", [db.cards], async () => {
    const fresh = (await db.cards.get(rec.key)) ?? rec;
    const u = { ...fresh, buriedUntil: nextDayStart(), updatedAt: Date.now() };
    await db.cards.put(u);
    return u;
  });
  scheduleSync();
  return updated;
}

/** Tira o card de todas as filas até ser reativado (Anki "suspend"). */
export async function suspendCard(rec: CardRecord): Promise<CardRecord> {
  const updated = await db.transaction("rw", [db.cards], async () => {
    const fresh = (await db.cards.get(rec.key)) ?? rec;
    const u = { ...fresh, suspended: true, updatedAt: Date.now() };
    await db.cards.put(u);
    return u;
  });
  scheduleSync();
  return updated;
}

export async function countSuspended(language: string): Promise<number> {
  return (await db.cards.where("language").equals(language).toArray()).filter((c) => c.suspended).length;
}

/** Reativa todos os suspensos do idioma. */
export async function unsuspendAll(language: string): Promise<number> {
  const now = Date.now();
  // ler e gravar na mesma transação: uma nota (outra aba) ou um card vindo do
  // sync entre os dois seria sobrescrito pela cópia velha — e, com `updatedAt`
  // de agora, a cópia velha venceria o last-write-wins nos outros aparelhos
  const n = await db.transaction("rw", db.cards, async () => {
    const sus = (await db.cards.where("language").equals(language).toArray()).filter((c) => c.suspended);
    if (sus.length) await db.cards.bulkPut(sus.map((c) => ({ ...c, suspended: false, updatedAt: now })));
    return sus.length;
  });
  if (n) scheduleSync();
  return n;
}

/**
 * Reinicia o card (Anki "forget"): volta a novo, sem memória de estabilidade e
 * dificuldade. O histórico de notas fica; o contador de repetições também.
 */
export async function forgetCard(rec: CardRecord, settings?: SrsSettings): Promise<CardRecord> {
  // ajustes lidos antes: nada assíncrono fora do Dexie dentro da transação
  const s = settings ?? (await getSrsSettings());
  const now = new Date();
  const updated = await db.transaction("rw", [db.cards], async () => {
    const fresh = (await db.cards.get(rec.key)) ?? rec;
    const c = scheduler(s).forget(toFsrs(fresh), now, false).card;
    const { buriedUntil: _b, ...base } = fresh;
    const u = { ...applyFsrs(base as CardRecord, c), updatedAt: now.getTime() };
    await db.cards.put(u);
    return u;
  });
  scheduleSync();
  return updated;
}

// ---- card info (o "Card info" do Anki, resumido) ----

// ---- reschedule (Anki: "reschedule cards on change") ----

/**
 * Recalcula o estado de cada card **repetindo o histórico de notas** com os
 * parâmetros atuais (novos `w`, retenção alvo, passos). É o que o Anki faz ao
 * marcar "reagendar cards" depois de otimizar. Só o estado muda — o log fica.
 */
export async function rescheduleAll(
  language: string,
  settings?: SrsSettings,
): Promise<{ changed: number; total: number }> {
  const s = settings ?? (await getSrsSettings());
  const f = scheduler(s);
  const now = new Date();
  // Tudo numa transação (o cálculo é síncrono, cabe nela): lido fora, uma nota
  // dada em outra aba ou um card chegado pelo sync durante o cálculo era
  // sobrescrito pela cópia velha — que, com `updatedAt` de agora, vencia o
  // last-write-wins e apagava a nota também nos outros aparelhos.
  const result = await db.transaction("rw", [db.cards, db.reviewLog], async () => {
    const [cards, logs] = await Promise.all([
      db.cards.where("language").equals(language).toArray(),
      db.reviewLog.where("language").equals(language).toArray(),
    ]);
    const updates = replayHistory(cards, logs, f, now);
    if (updates.length) await db.cards.bulkPut(updates);
    return { changed: updates.length, total: cards.length };
  });
  if (result.changed) scheduleSync();
  return result;
}
