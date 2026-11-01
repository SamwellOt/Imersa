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

function scan(hits: (text: string) => string[]): string[] {
  const out: string[] = [];
  for (const [path, text] of Object.entries(SOURCES)) {
    if (EXEMPT.test(path)) continue;
    for (const h of hits(text)) out.push(`${path.replace(/^.*\/src\//, "src/")}: ${h}`);
  }
  return out;
}

function offenders(pattern: RegExp, hitsOf: (p: RegExp, t: string) => string[]): string[] {
  return scan((text) => hitsOf(pattern, text));
}

const TABLES = "cards|reviewLog|immersionLog|doseProgress|settings|lineMarks|tombstones";
const WRITE_METHODS = new Set(["put", "bulkPut", "add", "bulkAdd", "update", "modify", "delete", "bulkDelete", "clear", "upsert"]);
const TABLE_REF = new RegExp(`\\bdb\\s*\\.\\s*(?:(${TABLES})\\b|table\\s*\\(\\s*["'](${TABLES})["']\\s*\\))`, "g");
const CHAIN_LINK = /\s*\.\s*([A-Za-z_$][\w$]*)/y;

/** Índice logo depois do `)` que fecha o `(` em `open`; respeita strings. */
function skipCall(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (c === '"' || c === "'" || c === "`") {
      k = skipString(text, k);
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return k + 1;
  }
  return text.length;
}

function skipString(text: string, k: number): number {
  const q = text[k];
  for (let j = k + 1; j < text.length; j++) {
    if (text[j] === "\\") j++;
    else if (text[j] === q) return j;
  }
  return text.length;
}

/**
 * Escritas diretas nas tabelas de estado de `text`. Vale a cadeia inteira depois de
 * `db.<tabela>` (ou `db.table("<tabela>")`): `.where(..).equals(..).delete()`,
 * `.modify(..)`, `.bulkPut(..)`, inclusive com quebras de linha entre os elos.
 */
function writesIn(text: string): string[] {
  const out: string[] = [];
  TABLE_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TABLE_REF.exec(text))) {
    const table = m[1] ?? m[2];
    let i = m.index + m[0].length;
    const chain: string[] = [];
    for (;;) {
      CHAIN_LINK.lastIndex = i;
      const link = CHAIN_LINK.exec(text);
      if (!link) break;
      chain.push(link[1]);
      i = CHAIN_LINK.lastIndex;
      const paren = /\s*\(/y;
      paren.lastIndex = i;
      if (paren.exec(text)) i = skipCall(text, paren.lastIndex - 1);
    }
    const write = chain.find((name) => WRITE_METHODS.has(name));
    if (write) out.push(`db.${table} … .${write}(`);
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

  it("controle: pega escrita encadeada (where/delete/modify, várias linhas, db.table)", () => {
    const pos = [
      'await db.cards\n  .where("doseId").equals(id)\n  .modify({ x: 1 });',
      'await db.cards.where("doseId").equals(id).delete();',
      'await db.table("cards").put(rec);',
      "await db.cards\n    .bulkPut(recs);",
      'await db.reviewLog.where("day").below(d)\n  .filter((r) => r.uid !== u)\n  .delete();',
    ];
    for (const s of pos) expect(writesIn(s).length).toBeGreaterThan(0);
  });

  it("controle: leitura, consulta e transação com a tabela como argumento não são escrita", () => {
    const neg = [
      'const c = await db.cards.where("language").equals(l).filter((r) => r.known).toArray();',
      "const r = await db.cards.get(key);",
      'await db.transaction("rw", db.cards, async () => {\n  const x = await db.cards.get(k);\n});',
      'const n = await db.reviewLog.where("day").equals(d).count();',
    ];
    for (const s of neg) expect(writesIn(s)).toEqual([]);
  });

  it("nenhum módulo fora do ledger escreve direto nas tabelas de estado", () => {
    expect(scan(writesIn)).toEqual([]);
  });

  it("nenhum módulo fora do ledger apaga com tombstone à mão", () => {
    expect(offenders(TOMBSTONE_CALL, lineHits)).toEqual([]);
  });

  it("nenhum módulo fora do ledger importa setSetting cru do banco", () => {
    expect(offenders(RAW_SETTING_IMPORT, blockHits)).toEqual([]);
  });
});
