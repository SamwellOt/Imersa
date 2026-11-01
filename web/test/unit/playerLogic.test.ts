// Regra pura do player, extraída do ImmersionPlayer (mesmo comportamento).
import { describe, it, expect } from "../harness";
import { RATES, PRIME_LEAD_MS, nextRate, formatRate, pickLines, nextPrimeTarget, assetBaseOf } from "@/components/player/playerLogic";
import type { Segment } from "@/types/dose";

const seg = (id: string, startMs: number, endMs: number): Segment => ({ id, index: 0, startMs, endMs, target: id });
const S = [seg("a", 0, 1000), seg("b", 2000, 3000), seg("c", 5000, 6000)];

describe("playerLogic", () => {
  it("velocidades", () => {
    expect([RATES, PRIME_LEAD_MS]).toEqual([[0.7, 0.85, 1, 1.15, 1.35], 100]);
    expect([1, 1.35, 1.2, 0.1, 0.7 - 1e-7].map(nextRate)).toEqual([1.15, 0.7, 1.35, 0.7, 0.85]);
    expect([1, 1.15, 0.7, 1.35, 2].map(formatRate)).toEqual(["1", "1.15", "0.7", "1.35", "2"]);
  });
  it("pickLines: linha ativa, janela do Prime e fala retida", () => {
    expect(pickLines(S, 500, 0, null)).toEqual({ line: S[0], primeSeg: null });
    expect(pickLines(S, 1900, -1, null)).toEqual({ line: null, primeSeg: S[1] });
    expect(pickLines(S, 1899, -1, null).primeSeg).toBeNull();
    expect(pickLines(S, 1500, -1, S[1]).primeSeg).toEqual(S[1]);
    expect(pickLines(S, 2000, 1, S[1]).primeSeg).toBeNull();
    expect(pickLines(S, 7000, 2, null)).toEqual({ line: S[2], primeSeg: null });
  });
  it("nextPrimeTarget pula a fala já pausada e as sem Prime", () => {
    const all = () => true;
    expect(nextPrimeTarget(S, 0, null, all)?.id).toBe("b");
    expect(nextPrimeTarget(S, 1871, null, all)?.id).toBe("c"); // 1900 − 30: a janela de b passou
    expect(nextPrimeTarget(S, 0, "b", all)?.id).toBe("c");
    expect(nextPrimeTarget(S, 0, null, (s) => s.id !== "b")?.id).toBe("c");
    expect(nextPrimeTarget(S, 6000, null, all)).toBeUndefined();
  });
  it("assetBaseOf", () => {
    expect(assetBaseOf("/content/ko/course/A1-01/media/v.mp4", "media/v.mp4")).toBe("/content/ko/course/A1-01/");
    expect(assetBaseOf("x", "longer")).toBe("");
  });
});
