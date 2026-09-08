// Dose progress + streak/stat helpers on top of the Dexie store.
import {
  db, dailyStats, getSetting, setSetting, LOCAL_SETTING,
  type DailyStat, type DosePhase, type DoseProgressRecord,
} from "./db";
import type { Course, DoseRef } from "@/types/dose";
import { scheduleSync } from "./sync";
import { dayKey, daysBetween, shiftDay } from "./utils";

export async function getDoseProgress(doseId: string): Promise<DoseProgressRecord | undefined> {
  return db.doseProgress.get(doseId);
}

export async function getAllProgress(language: string): Promise<Map<string, DoseProgressRecord>> {
  const rows = await db.doseProgress.where("language").equals(language).toArray();
  return new Map(rows.map((r) => [r.doseId, r]));
}

function blankProgress(doseId: string, language: string): DoseProgressRecord {
  return {
    doseId,
    language,
    phases: [],
    completed: false,
    lastMediaPositionMs: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Ler-alterar-gravar a linha de progresso **dentro de uma transação**.
 *
 * Sem isso, duas chamadas disparadas no mesmo tick (o `markPhaseDone` +
 * `completeDose` do fim da dose, ou o `saveMediaPosition` do vídeo correndo por
 * cima da troca de fase) liam a MESMA versão da linha e a última a gravar
 * apagava a alteração da outra — dose concluída que voltava a aparecer como
 * pendente, e `completedAt` perdido (some do streak e de `dailyStats`).
 * O IndexedDB serializa transações `rw` com o mesmo escopo, então agora elas
 * entram em fila em vez de se atropelarem.
 *
 * `mutate` devolve `null` quando não há nada a mudar — assim ler não vira
 * escrita, e uma alteração à toa não vira mudança para a sincronização carregar.
 */
async function updateProgress(
  doseId: string,
  language: string,
  mutate: (rec: DoseProgressRecord) => DoseProgressRecord | null,
): Promise<DoseProgressRecord> {
  return db.transaction("rw", db.doseProgress, async () => {
    const existing = await db.doseProgress.get(doseId);
    const base = existing ?? blankProgress(doseId, language);
    const next = mutate(base);
    if (!next && existing) return existing;
    const saved = { ...(next ?? base), updatedAt: Date.now() };
    await db.doseProgress.put(saved);
    return saved;
  });
}

/**
 * Abrir a dose NÃO grava nada (não há mais um `ensureDoseStarted`): a linha
 * nasce na primeira fase concluída. Uma linha vazia carimbada só por abrir a
 * dose vencia, no last-write-wins, a conclusão feita um pouco antes no outro
 * aparelho ainda offline — e a dose voltava a pendente nos dois.
 */
export async function markPhaseDone(doseId: string, language: string, phase: DosePhase): Promise<void> {
  await updateProgress(doseId, language, (rec) =>
    rec.phases.includes(phase) ? null : { ...rec, phases: [...rec.phases, phase] },
  );
  scheduleSync();
}

/**
 * Posição do vídeo — conveniência DESTE aparelho, fora de `doseProgress`.
 *
 * Ficava na mesma linha que `completed`, e cada gravação (a cada 5 s de vídeo)
 * carimbava o `updatedAt` da linha inteira. No last-write-wins, rever o vídeo
 * num aparelho enquanto o outro concluía a dose e ainda não tinha sincronizado
 * fazia a conclusão perder para a posição do vídeo. Como chave `local:` ela não
 * viaja — retomar o vídeo onde parou é coisa de cada aparelho.
 * `lastMediaPositionMs` no registro só sobrevive para ler o que já foi gravado.
 */
const mediaPosKey = (doseId: string) => `${LOCAL_SETTING}mediaPos:${doseId}`;

export async function saveMediaPosition(doseId: string, ms: number): Promise<void> {
  await setSetting(mediaPosKey(doseId), ms);
}

export async function getMediaPosition(doseId: string): Promise<number> {
  const local = await getSetting<number | null>(mediaPosKey(doseId), null);
  if (typeof local === "number") return local;
  return (await db.doseProgress.get(doseId))?.lastMediaPositionMs ?? 0;
}

export async function completeDose(doseId: string, language: string): Promise<void> {
  // `completedAt` é o que alimenta o "doses concluídas no dia" — o agregado é
  // derivado daqui (ver `dailyStats`), não guardado num contador à parte.
  await updateProgress(doseId, language, (rec) =>
    rec.completed
      ? null
      : {
          ...rec,
          phases: Array.from(new Set([...rec.phases, "prime", "immersion", "review"])) as DosePhase[],
          completed: true,
          completedAt: Date.now(),
        },
  );
  scheduleSync();
}

/** First dose in course order that isn't completed yet. */
export function nextDose(course: Course, progress: Map<string, DoseProgressRecord>): DoseRef | null {
  for (const d of course.doses) {
    const p = progress.get(d.id);
    if (!p || !p.completed) return d;
  }
  return null;
}

export interface StreakInfo {
  current: number;
  longest: number;
  activeToday: boolean;
}

/** Imersão mínima para um dia contar como estudado (abrir o vídeo por 3 s não é estudo). */
export const ACTIVE_IMMERSION_MS = 60_000;

/**
 * UMA régua para "dia com estudo": sequência, faixa da semana no Hoje e quadro
 * de 28 dias em /progress leem daqui. Antes a sequência contava qualquer
 * segundo de imersão e as outras duas exigiam 1 min — "3 dias seguidos" com
 * quadradinho cinza.
 */
export function dayIsActive(s: Pick<DailyStat, "reviews" | "immersionMs" | "dosesCompleted">): boolean {
  return s.reviews > 0 || s.immersionMs >= ACTIVE_IMMERSION_MS || s.dosesCompleted > 0;
}

/** A day "counts" for the streak if any review, ≥1 min of immersion, or a dose happened. */
export async function computeStreak(language: string): Promise<StreakInfo> {
  const stats = Array.from((await dailyStats(language)).values());
  const activeDays = new Set(stats.filter(dayIsActive).map((s) => s.day));
  const today = dayKey();
  const yesterday = shiftDay(today, -1);
  const activeToday = activeDays.has(today);

  // current streak: walk backward from today (or yesterday if not active today)
  let current = 0;
  let cursor: string | null = activeToday ? today : activeDays.has(yesterday) ? yesterday : null;
  while (cursor && activeDays.has(cursor)) {
    current++;
    cursor = shiftDay(cursor, -1);
  }

  // longest streak across all active days
  const sorted = Array.from(activeDays).sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of sorted) {
    if (prev && daysBetween(prev, d) === 1) run++;
    else run = 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  return { current, longest, activeToday };
}

export interface OverviewStats {
  streak: StreakInfo;
  cardsKnown: number; // reps>0
  cardsLearning: number;
  totalCards: number;
  dosesCompleted: number;
  immersionMsTotal: number;
  reviewsTotal: number;
}

export async function getOverview(language: string): Promise<OverviewStats> {
  const [cards, agg, progress, streak] = await Promise.all([
    db.cards.where("language").equals(language).toArray(),
    dailyStats(language),
    db.doseProgress.where("language").equals(language).toArray(),
    computeStreak(language),
  ]);
  const stats = Array.from(agg.values());
  return {
    streak,
    cardsKnown: cards.filter((c) => c.state === 2).length,
    cardsLearning: cards.filter((c) => c.state === 1 || c.state === 3).length,
    totalCards: cards.length,
    dosesCompleted: progress.filter((p) => p.completed).length,
    immersionMsTotal: stats.reduce((a, s) => a + s.immersionMs, 0),
    reviewsTotal: stats.reduce((a, s) => a + s.reviews, 0),
  };
}
