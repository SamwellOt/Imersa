// Medidor de imersão (lib/immersionMeter.ts): regra única para vídeo e Escuta.
// Relógio falso injetado + <audio> de verdade (eventos reais de play/pause).
import { describe, it, expect, beforeEach, resetDb, sleep, waitFor } from "../harness";
import { createImmersionMeter, type ImmersionMeter } from "@/lib/immersionMeter";
import { db } from "@/lib/db";

const AUDIO = "/content/ko/course/T1-01/media/a.mp3";
const T0 = 1_000_000;

let meters: ImmersionMeter[] = [];

/** Medidor com relógio controlado: `tick(ms)` avança o relógio e dispara um timeupdate. */
function setup() {
  const el = new Audio(AUDIO);
  let clock = T0;
  const credits: number[] = [];
  const m = createImmersionMeter({
    media: el,
    context: () => ({ language: "ko", doseId: "ko-T1-01" }),
    now: () => clock,
    onCredit: (ms) => credits.push(ms),
  });
  meters.push(m);
  const tick = (ms: number) => {
    clock += ms;
    el.dispatchEvent(new Event("timeupdate"));
  };
  const play = async () => {
    await el.play().catch(() => {});
  };
  /** Fecha a página: o que já tocou vira evento. */
  const hide = () => window.dispatchEvent(new Event("pagehide"));
  /** Relógio andando SEM evento de mídia (buffering, aba dormindo). */
  const advance = (ms: number) => {
    clock += ms;
  };
  return { el, m, credits, tick, play, hide, advance };
}

async function logged() {
  await sleep(30);
  return db.immersionLog.toArray();
}

async function onlyRow(what: string) {
  return waitFor(async () => {
    const r = await logged();
    return r.length === 1 ? r : null;
  }, 2000, what);
}

describe("medidor de imersão (núcleo)", () => {
  beforeEach(async () => {
    for (const m of meters) m.dispose();
    meters = [];
    await resetDb();
  });

  it("só conta com a mídia tocando", async () => {
    const s = setup();
    s.tick(5000);
    expect(s.credits).toEqual([]);
    s.hide();
    expect((await logged()).length).toBe(0);
  });

  it("cada amostra credita o tempo de parede, com teto de 2 s", async () => {
    const s = setup();
    await s.play();
    s.tick(5000);
    s.tick(1000);
    expect(s.credits).toEqual([2000, 1000]);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect(rows[0].ms).toBe(3000);
  });

  it("abaixo de 500 ms não grava (toque acidental)", async () => {
    const s = setup();
    await s.play();
    s.tick(300);
    s.hide();
    expect((await logged()).length).toBe(0);
  });

  it("fechar a página grava o que já tocou, com idioma e lição", async () => {
    const s = setup();
    await s.play();
    s.tick(1500);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect([rows[0].ms, rows[0].language, rows[0].doseId]).toEqual([1500, "ko", "ko-T1-01"]);
  });

  it("pausa não conta o tempo parado", async () => {
    const s = setup();
    await s.play();
    s.tick(1000);
    s.el.pause();
    await sleep(20); // o evento de pausa chega antes de o relógio andar
    s.tick(10_000);
    expect(s.credits).toEqual([1000]);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect(rows[0].ms).toBe(1000);
  });

  it("sessão longa grava a cada 60 s, não antes", async () => {
    const s = setup();
    await s.play();
    for (let i = 0; i < 59; i++) s.tick(1000);
    expect((await logged()).length).toBe(0);
    s.tick(1000);
    const rows = await onlyRow("gravação dos 60 s");
    expect(rows[0].ms).toBe(60_000);
  });

  it("aparelho que dormiu com a mídia tocando não credita a hora", async () => {
    const s = setup();
    await s.play();
    s.tick(3_600_000);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect(rows[0].ms).toBe(2000);
  });

  it("1,5× conta o tempo de parede, não o da mídia", async () => {
    const s = setup();
    s.el.playbackRate = 1.5;
    await s.play();
    s.tick(2000);
    s.tick(2000);
    s.tick(2000);
    expect(s.credits).toEqual([2000, 2000, 2000]);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect(rows[0].ms).toBe(6000);
  });

  it("pausar grava o que já tocou, sem esperar a página fechar", async () => {
    const s = setup();
    await s.play();
    s.tick(1500);
    s.el.pause();
    const rows = await onlyRow("gravação no pausar");
    expect(rows[0].ms).toBe(1500);
  });

  it("aba escondida grava o pendente (celular mata a aba sem pagehide)", async () => {
    const s = setup();
    await s.play();
    s.tick(1500);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
    const rows = await onlyRow("gravação ao esconder a aba");
    expect(rows[0].ms).toBe(1500);
  });

  it("aba visível não grava a cada visibilitychange (controle)", async () => {
    const s = setup();
    await s.play();
    s.tick(1500);
    document.dispatchEvent(new Event("visibilitychange"));
    await sleep(30);
    expect((await logged()).length).toBe(0);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect(rows[0].ms).toBe(1500);
  });

  it("buffering (waiting) não conta o tempo parado até o playing", async () => {
    const s = setup();
    await s.play();
    s.tick(1000);
    s.el.dispatchEvent(new Event("waiting"));
    s.advance(5000); // a rede travou: relógio anda, mídia não
    s.tick(1000); // timeupdate chega sem avanço de mídia
    s.el.dispatchEvent(new Event("playing"));
    s.tick(1000);
    expect(s.credits).toEqual([1000, 1000]);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect(rows[0].ms).toBe(2000);
  });

  it("o evento play sozinho, sem a mídia tocar, não abre intervalo", async () => {
    const s = setup();
    s.el.dispatchEvent(new Event("play"));
    s.tick(3000);
    expect(s.credits).toEqual([]);
    s.hide();
    expect((await logged()).length).toBe(0);
  });

  it("dispose grava o pendente, para de ouvir e não grava duas vezes", async () => {
    const s = setup();
    await s.play();
    s.tick(1000);
    s.m.dispose();
    s.tick(1000);
    s.hide();
    const rows = await onlyRow("evento de imersão");
    expect(rows[0].ms).toBe(1000);
    expect(s.credits).toEqual([1000]);
  });
});
