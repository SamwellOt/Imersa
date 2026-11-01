// Teste-trava do ledger: varre o FONTE de src/ (empacotado pelo Vite como texto)
// e falha se algum módulo fora do ledger escreve direto nas tabelas de estado,
// apaga com tombstone à mão ou importa `setSetting` cru do banco. A regra do
// CLAUDE.md ("ao mexer no estado do aluno…") passa a ser verificada, não lembrada.
// Quem pode escrever direto: lib/db.ts (reset, wipe, importação), lib/sync.ts
// (aplica o que veio do servidor, preservando o carimbo) e o próprio ledger.
import { describe, it, expect } from "../harness";

const SOURCES = import.meta.glob("../../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const EXEMPT = /src\/lib\/(ledger|db|sync)\.ts$/;
const DIRECT_WRITE = /\bdb\.(cards|reviewLog|immersionLog|doseProgress|settings|lineMarks|tombstones)\s*\.\s*(put|bulkPut|add|bulkAdd|update|modify|delete|bulkDelete|clear|upsert)\s*\(/;
const TOMBSTONE_CALL = /\btombstone\s*\(/;
const RAW_SETTING_IMPORT = /import\s*\{[^}]*\bsetSetting\b[^}]*\}\s*from\s*["'](?:[^"']*\/)?db["']/;

/** Linhas que casam (escritas e chamadas são de uma linha só). */
function lineHits(pattern: RegExp, text: string): string[] {
  return text.split("\n").filter((line) => pattern.test(line)).map((l) => l.trim());
}

/** Casos que cruzam linhas (import com várias linhas). */
function blockHits(pattern: RegExp, text: string): string[] {
  const m = pattern.exec(text);
  return m ? [m[0].replace(/\s+/g, " ")] : [];
}

function offenders(pattern: RegExp, hitsOf: (p: RegExp, t: string) => string[]): string[] {
  const out: string[] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    if (EXEMPT.test(path)) continue;
    for (const h of hitsOf(pattern, text)) out.push(`${path.replace(/^.*\/src\//, "src/")}: ${h}`);
  }
  return out;
}

describe("ledger: teste-trava (varredura do fonte)", () => {
  it("controle: a varredura enxerga uma escrita direta de verdade", () => {
    expect(DIRECT_WRITE.test("  await db.cards.put(rec);")).toBe(true);
    expect(TOMBSTONE_CALL.test('  await tombstone("card", key);')).toBe(true);
    expect(RAW_SETTING_IMPORT.test('import { db, setSetting } from "@/lib/db";')).toBe(true);
  });

  it("cobertura: o fonte de src/ foi lido (não passou por vazio)", () => {
    expect(Object.keys(SOURCES).length > 40).toBe(true);
    expect(Object.keys(SOURCES).some((p) => /src\/lib\/ledger\.ts$/.test(p))).toBe(true);
  });

  it("nenhum módulo fora do ledger escreve direto nas tabelas de estado", () => {
    expect(offenders(DIRECT_WRITE, lineHits)).toEqual([]);
  });

  it("nenhum módulo fora do ledger apaga com tombstone à mão", () => {
    expect(offenders(TOMBSTONE_CALL, lineHits)).toEqual([]);
  });

  it("nenhum módulo fora do ledger importa setSetting cru do banco", () => {
    expect(offenders(RAW_SETTING_IMPORT, blockHits)).toEqual([]);
  });
});
