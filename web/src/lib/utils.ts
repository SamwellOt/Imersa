import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** ms -> "M:SS" (or "H:MM:SS" for long media). */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** seconds -> human duration like "12 min" / "1 h 5 min". */
export function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

/**
 * Hora em que o "dia de estudo" vira — 4h da manhã, como no Anki.
 *
 * À meia-noite em ponto o dia NÃO muda: quem fecha a dose às 23h50 e revisa às
 * 0h10 ainda está no mesmo dia (mesma cota de palavras novas, mesma sequência).
 * Com a virada à meia-noite a cota zerava e dava para "fazer duas doses" numa
 * noite — o contrário do método de uma dose por dia.
 */
export const DAY_ROLLOVER_HOUR = 4;

/** Chave do dia de estudo (YYYY-MM-DD, local, virando às `DAY_ROLLOVER_HOUR`). */
export function dayKey(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() - DAY_ROLLOVER_HOUR * 3_600_000);
  const y = shifted.getFullYear();
  const m = (shifted.getMonth() + 1).toString().padStart(2, "0");
  const day = shifted.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const DAY_MS = 86_400_000;

/** Instante (epoch ms) em que começa o dia de estudo "YYYY-MM-DD" (às `DAY_ROLLOVER_HOUR`). */
export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, DAY_ROLLOVER_HOUR, 0, 0, 0).getTime();
}

/** Instante (epoch ms) em que começa o próximo dia de estudo. */
export function nextDayStart(from: Date = new Date()): number {
  return dayStart(shiftDay(dayKey(from), 1));
}

/**
 * Vencimento **por dia**, como no Anki: um card agendado para daqui a `days`
 * dias vence no **início do dia de estudo** (`dayStart`), não no mesmo horário
 * em que foi revisado. Assim "1 dia" revisado às 22h já está vencido de manhã
 * — o intervalo em dias é uma data, não um cronômetro. Só os passos de
 * (re)aprendizado em minutos continuam com hora exata.
 */
export function dueOnDay(fromMs: number, days: number): number {
  return dayStart(shiftDay(dayKey(new Date(fromMs)), Math.max(1, Math.round(days))));
}

/**
 * Traz para o modelo por dia um vencimento gravado com hora exata (registros
 * de antes desta regra, backups, outro aparelho com app antigo): vira o início
 * do dia de estudo em que ele caía. Intervalos em minutos passam intactos.
 */
export function snapDueToDay(dueMs: number, lastReviewMs: number | undefined, scheduledDays: number): number {
  if (!(scheduledDays >= 1)) return dueMs;
  const anchor = lastReviewMs ?? dueMs - scheduledDays * DAY_MS;
  // Em DIAS DE ESTUDO, não em ms — a função precisa ser idempotente, porque
  // roda de novo sobre cards que já vieram encaixados (sync, backup). Um `due`
  // às 4h de um card revisado às 22h dista N − 0,75 dias do `last_review`, e
  // arredondar em ms devolvia N − 1: cada aparelho que recebia o card via
  // sincronização encurtava o intervalo em um dia.
  const days = Math.max(1, daysBetween(dayKey(new Date(anchor)), dayKey(new Date(dueMs))));
  return dueOnDay(anchor, days);
}

/**
 * Anda `n` dias no calendário a partir de uma chave "YYYY-MM-DD".
 *
 * Usa aritmética de calendário, não `- 86_400_000`: num fuso com horário de
 * verão o dia tem 23 ou 25 horas, e subtrair 24 h fixas pula (ou repete) um dia
 * — o suficiente para quebrar uma sequência de estudo sem ninguém ter falhado.
 */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  // Ancorado ao MEIO-DIA: à meia-noite o `dayKey` (virada às 4h) ainda cai no
  // dia anterior, e `shiftDay(hoje, -1)` devolvia anteontem.
  return dayKey(new Date(y, m - 1, d + n, 12));
}

export function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00");
  const db = new Date(b + "T00:00:00");
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

export function pluralize(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

