// Doses de fixture (test/fixtures/content) e atalhos para montar estado.
import type { Dose } from "@/types/dose";
import { db, setSetting, type CardRecord } from "@/lib/db";
import type { SrsSettings } from "@/lib/srs";

const cache = new Map<string, Dose>();

export async function loadFixtureDose(n: 1 | 2): Promise<Dose> {
  const url = `/content/ko/course/T1-0${n}/dose.json`;
  if (!cache.has(url)) cache.set(url, await (await fetch(url)).json());
  return structuredClone(cache.get(url)!);
}

export async function saveSrs(patch: Partial<SrsSettings>) {
  await setSetting("srs", patch);
}

/** Registro de card mínimo, no formato que o app grava. */
export function rec(over: Partial<CardRecord> & { key: string }): CardRecord {
  const [doseId, cardId] = over.key.split("::");
  const now = Date.now();
  return {
    doseId, cardId, language: "ko",
    due: now, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0,
    reps: 0, lapses: 0, state: 0, introducedAt: now, updatedAt: now,
    ...over,
  } as CardRecord;
}

export async function putCards(...recs: CardRecord[]) {
  await db.cards.bulkPut(recs);
}

/** Tira `updatedAt`/`introducedAt` (carimbos) para comparar estado. */
export function strip<T extends object>(o: T | undefined | null) {
  if (!o) return o;
  const { updatedAt: _u, introducedAt: _i, ...rest } = o as Record<string, unknown>;
  return rest;
}
