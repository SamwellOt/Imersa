// Caracterização da página de Ajustes (pages/Settings.tsx).
import { describe, it, expect, beforeEach, afterEach, resetDb, findByText, queryByText, waitFor, textOf, setClock, at, restoreClock } from "../harness";
import { render, cleanup, click, settle } from "../render";
import { loadFixtureDose, saveSrs } from "../fixtures";
import { Settings } from "@/pages/Settings";
import { db, getSetting } from "@/lib/db";
import { markKnown, DEFAULT_SRS_SETTINGS, FSRS_DEFAULT_W, type SrsSettings } from "@/lib/srs";
import { SYNC_EVENT } from "@/lib/sync";
import { useApp } from "@/lib/store";

const storedSrs = () => getSetting<Partial<SrsSettings> | null>("srs", null);

/** A linha de ajuste (SettingRow) pelo título. */
function row(el: HTMLElement, title: string): HTMLElement {
  const t = queryByText(el, title, { selector: "div" });
  if (!t) throw new Error(`linha "${title}" ausente`);
  return t.parentElement!.parentElement!;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function blur(input: HTMLInputElement) {
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

/** Captura downloads (Blob + nome do arquivo) sem baixar nada. */
function captureDownloads() {
  const got: { name: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  const origCreate = URL.createObjectURL;
  const origClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = (b: Blob | MediaSource) => {
    const u = `blob:test/${blobs.size}`;
    blobs.set(u, b as Blob);
    return u;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    got.push({ name: this.download, blob: blobs.get(this.href)! });
  };
  return {
    got,
    restore() {
      URL.createObjectURL = origCreate;
      HTMLAnchorElement.prototype.click = origClick;
    },
  };
}

describe("Settings", () => {
  beforeEach(async () => {
    await resetDb();
    useApp.setState({ activeLanguage: "ko", subtitleMode: "both", primedAdaptive: false, subtitleMarks: false });
  });
  afterEach(() => cleanup());

  it("seções e textos principais", async () => {
    const el = render(<Settings />);
    await findByText(el, "Padrão do FSRS-6");
    for (const s of ["Aparência", "Imersão", "Repetição espaçada", "Parâmetros do FSRS", "Dados"]) {
      expect(queryByText(el, s)).toBeTruthy();
    }
    expect(textOf(el)).toContain("Precisa de pelo menos 400 revisões; você tem 0.");
    expect((queryByText(el, "Otimizar parâmetros", { selector: "button" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggle de ajuste SRS grava mesclado com o que está no banco", async () => {
    await saveSrs({ newPerDay: 30 });
    const el = render(<Settings />);
    await findByText(el, "Padrão do FSRS-6");
    click(el.querySelector('[aria-label="Cards de frase separados"]'));
    await waitFor(async () => (await storedSrs())?.sentenceCards === true, 2000, "gravou");
    expect(await storedSrs()).toEqual({ ...DEFAULT_SRS_SETTINGS, newPerDay: 30, sentenceCards: true });
    expect(el.querySelector('[aria-label="Cards de frase separados"]')!.getAttribute("aria-checked")).toBe("true");
  });

  it("steppers: passo, limites e retenção em %", async () => {
    await saveSrs({ newPerDay: 0 });
    const el = render(<Settings />);
    await findByText(el, "Padrão do FSRS-6");
    await settle();
    const npd = row(el, "Palavras novas por dia");
    expect((npd.querySelector('[aria-label="Diminuir"]') as HTMLButtonElement).disabled).toBe(true);
    click(npd.querySelector('[aria-label="Aumentar"]'));
    await waitFor(async () => (await storedSrs())?.newPerDay === 5, 2000, "newPerDay 5");
    const ret = row(el, "Retenção alvo");
    expect(textOf(ret.querySelector("span"))).toBe("90%");
    click(ret.querySelector('[aria-label="Aumentar"]'));
    await waitFor(async () => (await storedSrs())?.requestRetention === 0.91, 2000, "retenção 0.91");
    const ahead = row(el, "Antecipar aprendizado");
    expect(textOf(ahead.querySelector("span"))).toBe("20 min");
  });

  it("passos: inválido marca o campo e não grava; válido grava", async () => {
    const el = render(<Settings />);
    await findByText(el, "Padrão do FSRS-6");
    await settle();
    const input = row(el, "Passos de aprendizado").querySelector("input")!;
    expect(input.value).toBe("1m 10m");
    typeInto(input, "1x");
    blur(input);
    await settle();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(await storedSrs()).toBeNull();
    typeInto(input, "2m, 20m");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    blur(input);
    await waitFor(async () => (await storedSrs())?.learningSteps?.join() === "2m,20m", 2000, "passos");
    await settle();
    expect(input.value).toBe("2m 20m");
  });

  it("intervalo máximo: inteiro entre 30 e 36500", async () => {
    const el = render(<Settings />);
    await findByText(el, "Padrão do FSRS-6");
    await settle();
    const input = row(el, "Intervalo máximo").querySelector("input")!;
    expect(input.value).toBe("36500");
    typeInto(input, "10");
    blur(input);
    await settle();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    typeInto(input, "100.5");
    blur(input);
    await settle();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    typeInto(input, "100");
    blur(input);
    await waitFor(async () => (await storedSrs())?.maximumInterval === 100, 2000, "intervalo");
  });

  it("parâmetros à mão, título 'Otimizados' e voltar ao padrão", async () => {
    setClock(at(2026, 10, 10, 12));
    try {
      const el = render(<Settings />);
      await findByText(el, "Padrão do FSRS-6");
      const input = el.querySelector<HTMLInputElement>('details input')!;
      typeInto(input, "1, 2");
      blur(input);
      await settle();
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const w = FSRS_DEFAULT_W.map((n) => +n.toFixed(4));
      typeInto(input, w.join(", "));
      blur(input);
      await waitFor(async () => Array.isArray((await storedSrs())?.w), 2000, "w gravado");
      const s = await storedSrs();
      expect([s!.w!.length, s!.wOptimizedAt, s!.wReviews]).toEqual([21, at(2026, 10, 10, 12), 0]);
      await findByText(el, "Otimizados em 10 de out. de 2026", { selector: "div" });
      click(await findByText(el, "Voltar ao padrão", { selector: "button" }));
      await waitFor(async () => (await storedSrs())?.w === null, 2000, "padrão");
      await findByText(el, "Padrão do FSRS-6");
    } finally {
      restoreClock();
    }
  });

  it("sincronização que trouxe ajustes atualiza a tela", async () => {
    const el = render(<Settings />);
    await findByText(el, "Padrão do FSRS-6");
    await saveSrs({ newPerDay: 40 });
    dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { received: 0 } }));
    await settle(100);
    expect(textOf(row(el, "Palavras novas por dia").querySelector("span"))).toBe("20");
    dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { received: 2 } }));
    await waitFor(() => textOf(row(el, "Palavras novas por dia").querySelector("span")) === "40", 2000, "40");
  });

  it("legendas e Prime adaptativo mexem no mesmo estado do player", async () => {
    const el = render(<Settings />);
    await findByText(el, "Padrão do FSRS-6");
    const legendas = queryByText(el, "Legendas", { selector: "div" })!.parentElement!;
    expect(Array.from(legendas.querySelectorAll('[role="tab"]')).map(textOf)).toEqual(["Alvo", "PT", "Ambas", "Primed", "Off"]);
    click(queryByText(el, "PT", { selector: '[role="tab"]' }));
    expect(useApp.getState().subtitleMode).toBe("translation");
    click(el.querySelector('[aria-label="Prime adaptativo"]'));
    expect(useApp.getState().primedAdaptive).toBe(true);
  });

  it("revisões no idioma e Reagendar", async () => {
    await db.reviewLog.bulkAdd([1, 2, 3].map((i) => ({
      uid: `u${i}`, key: "k", doseId: "d", language: "ko", rating: 3, reviewedAt: i, day: "2026-10-10", elapsedMs: 1, state: 0,
    })));
    const el = render(<Settings />);
    await findByText(el, "você tem 3.", { partial: true, selector: "div" });
    click(await findByText(el, "Reagendar cards", { selector: "button" }));
    await findByText(el, "0 de 0 cards reagendados.");
  });

  it("Reagendar com falha avisa e libera o botão", async () => {
    const el = render(<Settings />);
    const btn = await findByText(el, "Reagendar cards", { selector: "button" });
    await settle();
    db.close();
    try {
      click(btn);
      await waitFor(() => textOf(el.querySelector(".fixed")).startsWith("Não deu para reagendar:"), 3000, "aviso de falha");
      await waitFor(() => !(btn as HTMLButtonElement).disabled, 2000, "botão liberado");
    } finally {
      await db.open();
    }
  });

  it("exportar «já sei» e backup: nome, formato e aviso", async () => {
    const dose = await loadFixtureDose(1);
    await markKnown(dose, dose.cards[1]);
    await markKnown(dose, dose.cards[0]);
    const dl = captureDownloads();
    try {
      const el = render(<Settings />);
      await findByText(el, "Padrão do FSRS-6");
      click(row(el, "Exportar «já sei»").querySelector("button"));
      await findByText(el, "2 palavras exportadas.");
      expect(dl.got[0].name).toBe("imersa-ja-sei-ko.json");
      expect(await dl.got[0].blob.text()).toBe('{\n "language": "ko",\n "lemmas": [\n  "가방",\n  "나무"\n ]\n}');
      click(row(el, "Exportar progresso").querySelector("button"));
      await findByText(el, "Backup exportado.");
      expect(/^imersa-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.got[1].name)).toBe(true);
      const text = await dl.got[1].blob.text();
      expect(text.startsWith('{\n  "')).toBe(true);
      expect(JSON.parse(text).cards.length).toBe(2);
    } finally {
      dl.restore();
    }
  });

  it("reiniciar/apagar sem confirmar não faz nada; importar arquivo inválido avisa", async () => {
    const dose = await loadFixtureDose(1);
    await markKnown(dose, dose.cards[0]);
    const origConfirm = window.confirm;
    const asked: string[] = [];
    window.confirm = (m?: string) => {
      asked.push(m ?? "");
      return false;
    };
    try {
      const el = render(<Settings />);
      await findByText(el, "Padrão do FSRS-6");
      click(row(el, "Reiniciar este idioma").querySelector("button"));
      click(row(el, "Apagar tudo").querySelector("button"));
      await settle();
      expect(asked).toEqual([
        "Isso zera o progresso do idioma atual (ko). Continuar?",
        "Isso apaga todo o seu progresso (cards, revisões, estatísticas). Continuar?",
      ]);
      expect(await db.cards.count()).toBe(1);
      const file = new File(["não é json"], "x.json", { type: "application/json" });
      const input = row(el, "Importar progresso").querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await waitFor(() => /JSON|token/i.test(textOf(el.querySelector(".fixed"))), 2000, "aviso de erro");
      expect(await db.cards.count()).toBe(1);
    } finally {
      window.confirm = origConfirm;
    }
  });
});
