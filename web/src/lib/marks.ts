// «Não entendi» por fala: o aluno marca, durante a imersão, a linha que não
// entendeu. É a compreensão REAL da lição — a do vocabulário (`vocab.ts`) é só a
// prevista. Guardado como EVENTO (`lineMarks`, id global): desmarcar apaga com
// tombstone, marcar de novo cria outro evento.
import { db, newUid, tombstone, type MarkRecord } from "./db";
import { scheduleSync } from "./sync";
import { dayKey } from "./utils";

export async function toggleMark(language: string, doseId: string, segmentId: string): Promise<boolean> {
  const cur = (await db.lineMarks.where("doseId").equals(doseId).toArray())
    .filter((m) => m.segmentId === segmentId);
  if (cur.length) {
    await db.transaction("rw", [db.lineMarks, db.tombstones], async () => {
      for (const m of cur) {
        await db.lineMarks.delete(m.uid);
        await tombstone("mark", m.uid);
      }
    });
    scheduleSync();
    return false;
  }
  const now = Date.now();
  await db.lineMarks.add({ uid: newUid(), language, doseId, segmentId, day: dayKey(new Date(now)), at: now });
  scheduleSync();
  return true;
}

export async function marksOf(doseId: string): Promise<Set<string>> {
  const recs = await db.lineMarks.where("doseId").equals(doseId).toArray();
  return new Set(recs.map((m) => m.segmentId));
}

export async function marksByDose(language: string): Promise<Map<string, MarkRecord[]>> {
  const out = new Map<string, MarkRecord[]>();
  for (const m of await db.lineMarks.where("language").equals(language).toArray()) {
    const arr = out.get(m.doseId);
    if (arr) arr.push(m);
    else out.set(m.doseId, [m]);
  }
  return out;
}
