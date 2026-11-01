// Ledger de escrita (lib/ledger.ts): é o ÚNICO caminho para gravar estado e
// eventos sincronizáveis fora do banco/sync. Testes pela própria API, com
// IndexedDB real e relógio falso — o carimbo, a transação e o tombstone são
// o que a sincronização depende.
import { describe, it, expect, beforeEach, resetDb, setClock, at } from "../harness";
import { rec, putCards } from "../fixtures";
import { db, getSetting } from "@/lib/db";
import { putState, updateState, removeState, appendEvent, removeEvent, setSetting } from "@/lib/ledger";

const NOW = at(2026, 10, 10, 12);

describe("ledger: estado (card / progresso / ajuste)", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
  });

  it("putState carimba updatedAt com o relógio de agora (o chamador não precisa)", async () => {
    await putState("card", rec({ key: "a::w-1", updatedAt: 5 }));
    expect((await db.cards.get("a::w-1"))!.updatedAt).toBe(NOW);
  });

  it("setSetting grava com carimbo e getSetting lê de volta", async () => {
    await setSetting("srs", { newPerDay: 5 });
    expect((await db.settings.get("srs"))!.updatedAt).toBe(NOW);
    expect(await getSetting("srs", null)).toEqual({ newPerDay: 5 });
  });

  it("updateState: ler-alterar-gravar é atômico — escritas simultâneas não se apagam", async () => {
    await putCards(rec({ key: "a::w-1", reps: 0 }));
    await Promise.all(
      Array.from({ length: 5 }, () => updateState("card", "a::w-1", (c) => ({ ...c!, reps: c!.reps + 1 }))),
    );
    expect((await db.cards.get("a::w-1"))!.reps).toBe(5);
  });

  it("updateState que devolve null não grava nem carimba", async () => {
    await putCards(rec({ key: "a::w-1", updatedAt: 7 }));
    await updateState("card", "a::w-1", () => null);
    expect((await db.cards.get("a::w-1"))!.updatedAt).toBe(7);
  });

  it("removeState apaga e grava o tombstone na mesma transação", async () => {
    await putCards(rec({ key: "a::w-1" }));
    await removeState("card", "a::w-1");
    expect(await db.cards.count()).toBe(0);
    expect((await db.tombstones.toArray()).map((t) => [t.tid, t.deletedAt])).toEqual([["card:a::w-1", NOW]]);
  });

  it("removeState de chave local (local:) apaga sem tombstone — não sai do aparelho", async () => {
    await setSetting("local:mediaPos:x", 5);
    await removeState("setting", "local:mediaPos:x");
    expect(await db.settings.count()).toBe(0);
    expect(await db.tombstones.count()).toBe(0);
  });

  it("removeState de ajuste sincronizado gera tombstone do tipo setting", async () => {
    await setSetting("srs", { newPerDay: 5 });
    await removeState("setting", "srs");
    expect((await db.tombstones.toArray()).map((t) => t.tid)).toEqual(["setting:srs"]);
  });
});

describe("ledger: eventos (revisão / imersão / marca)", () => {
  beforeEach(async () => {
    await resetDb();
    setClock(NOW);
  });

  it("appendEvent acrescenta e removeEvent apaga com tombstone do tipo certo", async () => {
    await appendEvent("immersion", { uid: "i1", language: "ko", day: "2026-11-10", ms: 1000, at: NOW });
    expect(await db.immersionLog.count()).toBe(1);
    await removeEvent("immersion", "i1");
    expect(await db.immersionLog.count()).toBe(0);
    expect((await db.tombstones.toArray()).map((t) => t.tid)).toEqual(["immersion:i1"]);
  });

  it("marca de fala usa a tabela lineMarks e o tombstone mark", async () => {
    await appendEvent("mark", { uid: "m1", language: "ko", doseId: "ko-T1-01", segmentId: "s1", day: "2026-11-10", at: NOW });
    expect(await db.lineMarks.count()).toBe(1);
    await removeEvent("mark", "m1");
    expect((await db.tombstones.toArray()).map((t) => t.tid)).toEqual(["mark:m1"]);
  });
});
