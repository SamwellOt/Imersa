// Teste-trava das camadas: `src/lib/**` é domínio sem tela e nunca importa de
// `components/` nem de `pages/` (nem `import type`, nem `import()` dinâmico).
// Tipo que a tela e o domínio compartilham mora em lib/ e a tela importa de lá.
// Origem: code review de 01/11 (lib/reviewSession importava tipo do Flashcard).
import { describe, it, expect } from "../harness";

const LIB = import.meta.glob("../../src/lib/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Especificador de módulo apontando para a camada de tela (alias ou relativo). */
const UI_SPECIFIER = /^(?:@\/(?:components|pages)(?:\/|$)|(?:\.\.\/)+(?:components|pages)(?:\/|$))/;
/** `from "x"` (import/export, inclusive `import type`) e `import("x")`. */
const SPECIFIERS = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

function uiImports(text: string): string[] {
  return [...text.matchAll(SPECIFIERS)].map((m) => m[1]).filter((s) => UI_SPECIFIER.test(s));
}

describe("camadas: lib/ não depende da tela", () => {
  it("nenhum módulo de src/lib importa de components/ ou pages/", () => {
    const hits = Object.entries(LIB).flatMap(([path, text]) =>
      uiImports(text).map((s) => `${path.replace(/^.*\/src\//, "src/")}: ${s}`),
    );
    expect(hits).toEqual([]);
  });

  it("a trava reconhece as formas de import da tela e deixa passar as de lib", () => {
    expect(uiImports('import type { ResolvedExample } from "@/components/srs/Flashcard";')).toEqual(["@/components/srs/Flashcard"]);
    expect(uiImports('export { X } from "../../components/ui/Card";')).toEqual(["../../components/ui/Card"]);
    expect(uiImports('const m = await import("@/pages/Settings");')).toEqual(["@/pages/Settings"]);
    expect(uiImports('import { db } from "@/lib/db";\nimport { x } from "./componentsHelper";')).toEqual([]);
  });

  it("a varredura enxerga o fonte de lib/", () => {
    expect(Object.keys(LIB).length).toBeGreaterThan(20);
    expect(Object.keys(LIB).some((p) => /src\/lib\/ledger\.ts$/.test(p))).toBe(true);
  });
});
