// Estatísticas de retenção no molde do Anki (Stats → True retention, Future
// due, Answer buttons, Card counts). Tudo derivado do log e do estado dos cards
// — nada é armazenado.
import { State } from "ts-fsrs";
import { db } from "./db";
import { cardInfo, isActive, isLearningState, type SrsSettings } from "./srs";
import { dayKey, shiftDay } from "./utils";

export interface RetentionWindow {
  passed: number;
  total: number;
  /** Taxa de acerto 0..1, ou `null` sem amostra. */
  rate: number | null;
}

export interface ForecastDay {
  day: string; // YYYY-MM-DD
  count: number;
}

export interface SrsStats {
  /** "Retenção real": acertos em cards que estavam em **revisão** (não em
   *  aprendizado) — é a medida que o FSRS tenta levar à retenção alvo. */
  trueRetention: { today: RetentionWindow; week: RetentionWindow; month: RetentionWindow; all: RetentionWindow };
  /** Botões dos últimos 30 dias (todas as notas). */
  buttons: { again: number; hard: number; good: number; easy: number; total: number };
  /** Média da probabilidade de lembrar agora, nos cards em revisão. */
  avgRetrievability: number | null;
  /** Vencimentos por dia: hoje (com os atrasados) + próximos 6 dias. */
  forecast: ForecastDay[];
  overdue: number;
  states: { new: number; learning: number; review: number; relearning: number; suspended: number; buried: number };
  avgIntervalDays: number | null;
  avgStabilityDays: number | null;
  /** Total de notas no log (o piso do otimizador é sobre isto). */
  reviewsTotal: number;
}

function window_(passed: number, total: number): RetentionWindow {
  return { passed, total, rate: total ? passed / total : null };
}

export async function computeSrsStats(language: string, settings: SrsSettings): Promise<SrsStats> {
  const now = Date.now();
  const [cards, logs] = await Promise.all([
    db.cards.where("language").equals(language).toArray(),
    db.reviewLog.where("language").equals(language).toArray(),
  ]);
  const today = dayKey();
  const weekStart = shiftDay(today, -6);
  const monthStart = shiftDay(today, -29);

  // true retention: só notas dadas a cards em revisão
  const acc = { today: [0, 0], week: [0, 0], month: [0, 0], all: [0, 0] } as Record<string, number[]>;
  const buttons = { again: 0, hard: 0, good: 0, easy: 0, total: 0 };
  for (const r of logs) {
    if (r.day >= monthStart) {
      buttons.total++;
      if (r.rating === 1) buttons.again++;
      else if (r.rating === 2) buttons.hard++;
      else if (r.rating === 3) buttons.good++;
      else if (r.rating === 4) buttons.easy++;
    }
    if (r.state !== State.Review) continue;
    const ok = r.rating > 1 ? 1 : 0;
    acc.all[0] += ok; acc.all[1]++;
    if (r.day >= monthStart) { acc.month[0] += ok; acc.month[1]++; }
    if (r.day >= weekStart) { acc.week[0] += ok; acc.week[1]++; }
    if (r.day === today) { acc.today[0] += ok; acc.today[1]++; }
  }

  const states = { new: 0, learning: 0, review: 0, relearning: 0, suspended: 0, buried: 0 };
  const forecastMap = new Map<string, number>();
  const days: string[] = Array.from({ length: 7 }, (_, i) => shiftDay(today, i));
  for (const d of days) forecastMap.set(d, 0);
  let overdue = 0;
  let rSum = 0, rN = 0, ivlSum = 0, ivlN = 0, stabSum = 0;
  for (const c of cards) {
    if (c.suspended) { states.suspended++; continue; }
    if (!isActive(c, now)) states.buried++;
    if (c.state === State.New) states.new++;
    else if (c.state === State.Learning) states.learning++;
    else if (c.state === State.Relearning) states.relearning++;
    else states.review++;
    if (c.state === State.Review) {
      rSum += cardInfo(c, settings, now).retrievability; rN++;
      ivlSum += c.scheduled_days; stabSum += c.stability; ivlN++;
    }
    if (c.state === State.New) continue;
    // Card adiado não está atrasado: ele volta no início do próximo dia. O Hoje
    // e o badge (`countDue`) já o ignoravam; aqui ele inflava "N atrasados".
    const avail = Math.max(c.due, c.buriedUntil ?? 0);
    const d = avail <= now ? today : dayKey(new Date(avail));
    if (avail <= now) overdue++;
    if (forecastMap.has(d)) forecastMap.set(d, forecastMap.get(d)! + 1);
  }

  return {
    trueRetention: {
      today: window_(acc.today[0], acc.today[1]),
      week: window_(acc.week[0], acc.week[1]),
      month: window_(acc.month[0], acc.month[1]),
      all: window_(acc.all[0], acc.all[1]),
    },
    buttons,
    avgRetrievability: rN ? rSum / rN : null,
    forecast: days.map((day) => ({ day, count: forecastMap.get(day) ?? 0 })),
    overdue,
    states,
    avgIntervalDays: ivlN ? ivlSum / ivlN : null,
    avgStabilityDays: ivlN ? stabSum / ivlN : null,
    reviewsTotal: logs.length,
  };
}

/** Só para os cards ainda não em revisão: quantos estão em (re)aprendizado agora. */
export function countLearning(cards: { state: State }[]): number {
  return cards.filter((c) => isLearningState(c as never)).length;
}
