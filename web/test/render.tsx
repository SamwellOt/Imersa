import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { sleep } from "./harness";

let mounted: { root: Root; el: HTMLElement } | null = null;

/** Monta o componente num contêiner novo (desmonta o anterior). */
export function render(ui: ReactElement): HTMLElement {
  cleanup();
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  root.render(<MemoryRouter>{ui}</MemoryRouter>);
  mounted = { root, el };
  return el;
}

export function cleanup() {
  if (!mounted) return;
  mounted.root.unmount();
  mounted.el.remove();
  mounted = null;
}

/** Dá ao React tempo de reagir a um evento (efeitos + IndexedDB). */
export async function settle(ms = 60) {
  await sleep(ms);
}

export function click(el: Element | null) {
  if (!el) throw new Error("click: elemento ausente");
  (el as HTMLElement).click();
}
