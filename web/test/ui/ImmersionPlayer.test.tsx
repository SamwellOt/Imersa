// Caracterização do player de imersão (components/player/ImmersionPlayer.tsx).
import { describe, it, expect, beforeEach, afterEach, resetDb, findByText, queryByText, waitFor, press, textOf, byLabel, sleep } from "../harness";
import { render, cleanup, click, settle } from "../render";
import { loadFixtureDose, rec, putCards } from "../fixtures";
import { ImmersionPlayer } from "@/components/player/ImmersionPlayer";
import { db } from "@/lib/db";
import { useApp, type SubtitleMode } from "@/lib/store";
import type { Dose } from "@/types/dose";

const AUDIO = "/content/ko/course/T1-01/media/a.mp3";
const VIDEO = "/content/ko/course/T1-01/media/v.mp4";

async function mount(opts: { mode?: SubtitleMode; dose?: Dose; mediaUrl?: string; initialMs?: number; cb?: Partial<Record<"onListened" | "onPositionChange" | "onEnded", (x?: number) => void>> } = {}) {
  useApp.setState({ subtitleMode: opts.mode ?? "both" });
  const dose = opts.dose ?? (await loadFixtureDose(1));
  const el = render(
    <ImmersionPlayer dose={dose} mediaUrl={opts.mediaUrl ?? AUDIO} initialMs={opts.initialMs} {...opts.cb} />,
  );
  // a duração só aparece depois do loadedmetadata
  await findByText(el, "0:08", { selector: "span" });
  await settle();
  return el;
}
/** O painel de legenda do áudio (faixa abaixo do palco). */
const caption = (el: HTMLElement) => textOf(el.querySelector(".border-t.border-line.bg-surface-2"));

describe("ImmersionPlayer", () => {
  beforeEach(async () => {
    await resetDb();
    useApp.setState({ playbackRate: 1, subtitleMarks: false, primedAdaptive: false, transcriptOpen: true });
  });
  afterEach(() => cleanup());

  it("áudio: título, legenda em cada modo", async () => {
    const out: Record<string, string> = {};
    for (const mode of ["both", "target", "translation", "off", "primed"] as const) {
      const el = await mount({ mode });
      out[mode] = caption(el);
      if (mode === "both") expect(textOf(el)).toContain("하나");
    }
    expect(out).toEqual({
      both: "가방 하나uma bolsa",
      target: "가방 하나",
      translation: "uma bolsa",
      off: "Legendas desligadas",
      primed: "Dê play para continuar",
    });
  });

  it("seletor de legenda escreve no store", async () => {
    const el = await mount();
    expect(Array.from(el.querySelectorAll('[role="tab"]')).map(textOf)).toEqual(["Alvo", "PT", "Ambas", "Primed", "Off"]);
    click(queryByText(el, "PT", { selector: '[role="tab"]' }));
    expect(useApp.getState().subtitleMode).toBe("translation");
    await settle();
    expect(caption(el)).toBe("uma bolsa");
  });

  it("velocidade: próxima acima da atual, volta a 0,7 e tolera valor fora da lista", async () => {
    const el = await mount();
    const btn = () => el.querySelector<HTMLButtonElement>('[title="Velocidade de reprodução"]')!;
    const seq: string[] = [textOf(btn())];
    for (let i = 0; i < 5; i++) {
      click(btn());
      await settle(20);
      seq.push(textOf(btn()));
    }
    expect(seq).toEqual(["1×", "1.15×", "1.35×", "0.7×", "0.85×", "1×"]);
    expect(el.querySelector("audio")!.playbackRate).toBe(1);
    useApp.setState({ playbackRate: 1.2 });
    await settle(20);
    expect(textOf(btn())).toBe("1.2×");
    click(btn());
    expect(useApp.getState().playbackRate).toBe(1.35);
  });

  it("N marca/desmarca «não entendi» na fala atual", async () => {
    const el = await mount();
    press("n");
    await waitFor(async () => (await db.lineMarks.count()) === 1, 2000, "marca");
    const m = (await db.lineMarks.toArray())[0];
    expect([m.doseId, m.segmentId, m.language]).toEqual(["ko-T1-01", "s1", "ko"]);
    await waitFor(() => textOf(el.querySelector("aside")).includes("3 falas, 1 não entendida"), 2000, "cabeçalho");
    expect(byLabel(el, "Desmarcar «não entendi» (N)")).toBeTruthy();
    press("n");
    await waitFor(async () => (await db.lineMarks.count()) === 0, 2000, "desmarcou");
    expect(await db.tombstones.count()).toBe(1);
  });

  it("L liga o loop; T fecha e abre a transcrição (desktop)", async () => {
    const el = await mount();
    expect(byLabel(el, "Repetir em loop (L)")!.getAttribute("aria-pressed")).toBe("false");
    press("l");
    await settle(20);
    expect(byLabel(el, "Repetir em loop (L)")!.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector("aside")).toBeTruthy();
    expect(textOf(el.querySelector("aside"))).toContain("Transcrição3 falas");
    press("t");
    await settle(20);
    expect(useApp.getState().transcriptOpen).toBe(false);
    expect(el.querySelector("aside")).toBeNull();
    expect(byLabel(el, "Abrir a transcrição (T)")).toBeTruthy();
    press("t");
    await settle(20);
    expect(el.querySelector("aside")).toBeTruthy();
  });

  it("Ctrl/Alt não disparam atalhos", async () => {
    const el = await mount();
    press("l", { ctrlKey: true });
    press("t", { altKey: true });
    await settle(20);
    expect(byLabel(el, "Repetir em loop (L)")!.getAttribute("aria-pressed")).toBe("false");
    expect(useApp.getState().transcriptOpen).toBe(true);
  });

  it("navegação: → próxima fala, slider ±5 s, marcador de partes", async () => {
    const el = await mount();
    press("ArrowRight");
    await waitFor(() => caption(el) === "나무 둘duas árvores", 3000, "fala 2");
    const slider = el.querySelector<HTMLElement>('[role="slider"]')!;
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await waitFor(() => slider.getAttribute("aria-valuenow") === "8", 3000, "+5 s");
    expect(slider.getAttribute("aria-valuemax")).toBe("8");
    // partes com startMs > 0 viram marcas na linha do tempo
    expect(slider.querySelectorAll('span[title="Parte 2"]').length).toBe(1);
    await settle(300);
    expect(el.querySelector("audio")!.currentTime).toBe(7.5);
    // ← com mais de 1,2 s dentro da fala: volta ao começo DELA (5 s), não à anterior
    press("ArrowLeft");
    await waitFor(() => caption(el) === "다리 셋três pernas", 3000, "começo da fala");
    expect(el.querySelector("audio")!.currentTime).toBe(5);
  });

  it("retomado de posição salva > 15 s oferece voltar ao início", async () => {
    let el = await mount({ initialMs: 10_000 });
    expect(queryByText(el, "Retomado em", { partial: true, selector: "button" })).toBeNull();
    el = await mount({ initialMs: 6_000 + 14_000 });
    expect(textOf(queryByText(el, "Retomado em", { partial: true, selector: "button" }))).toBe("Retomado em 0:20, voltar ao início");
  });

  it("marcas de conhecimento e Prime adaptativo (rótulos)", async () => {
    await putCards(rec({ key: "ko-T1-02::w-가방", state: 2 }), rec({ key: "ko-T1-02::w-나무", state: 1 }));
    useApp.setState({ subtitleMarks: true });
    let el = await mount();
    await waitFor(() => textOf(el.querySelector("aside")).includes("já fixado"), 2000, "% fixado");
    expect(textOf(el.querySelector("aside > div"))).toBe("Transcrição3 falas, 33% já fixado");
    expect(byLabel(el, "Ocultar marcas de palavra")!.getAttribute("aria-pressed")).toBe("true");
    useApp.setState({ primedAdaptive: true });
    el = await mount({ mode: "primed" });
    await waitFor(() => byLabel(el, "Prime adaptativo ligado: pausa em 2 de 3 falas (só as com palavra nova)"), 2000, "rótulo adaptativo");
    useApp.setState({ primedAdaptive: false });
    await settle(20);
    expect(byLabel(el, "Prime adaptativo: pausar só nas falas com palavra nova")).toBeTruthy();
  });

  it("Primed: pausa 0,1 s antes da próxima fala e mostra a tradução", async () => {
    const listened: number[] = [];
    const el = await mount({ mode: "primed", cb: { onListened: (d) => void listened.push(d!) } });
    click(byLabel(el, "Reproduzir"));
    await waitFor(() => caption(el).startsWith("Prime"), 6000, "pausa do Prime");
    expect(caption(el)).toBe("Prime · leia e dê playduas árvores");
    const audio = el.querySelector("audio")!;
    expect(audio.paused).toBe(true);
    expect(Math.abs(audio.currentTime * 1000 - 2400)).toBeLessThan(60);
    expect(byLabel(el, "Reproduzir")).toBeTruthy();
    expect(listened.length).toBeGreaterThan(0);
    // retoma: a legenda fica até a fala começar, depois "Ouvindo…"
    click(byLabel(el, "Reproduzir"));
    await waitFor(() => caption(el) === "Ouvindo…", 3000, "ouvindo");
  });

  it("vídeo: legenda sobre o quadro, overlay do Prime e cinema (F / Esc)", async () => {
    const dose = await loadFixtureDose(1);
    dose.media = { ...dose.media, kind: "video", src: "media/v.mp4" };
    const el = await mount({ dose, mediaUrl: VIDEO });
    const overlay = () => textOf(el.querySelector(".absolute.inset-x-0.bottom-0"));
    expect(overlay()).toBe("가방 하나uma bolsa");
    expect(el.querySelector(".border-t.border-line.bg-surface-2")).toBeNull();
    const root = el.querySelector<HTMLElement>("[class*='flex-col'][class*='gap-4']")!;
    expect(root.getAttribute("data-theme")).toBeNull();
    press("f");
    await settle(50);
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.className).toContain("fixed inset-0");
    expect(document.body.style.overflow).toBe("hidden");
    expect(byLabel(el, "Sair da tela cheia (Esc)")).toBeTruthy();
    expect(el.querySelector("aside")).toBeNull();
    press("Escape");
    await settle(50);
    expect(root.getAttribute("data-theme")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    useApp.setState({ subtitleMode: "primed" });
    await sleep(50);
    expect(el.querySelector(".bg-black\\/60")!.className).toContain("opacity-0");
  });
});
