// Mini-harness de testes do web/, sem dependência nova: roda no Chrome headless
// (IndexedDB de verdade, DOM de verdade), empacotado pelo Vite. Ver test/run.mjs.
//
// Testes de CARACTERIZAÇÃO: registram o comportamento de hoje (mesmo o que
// parecer estranho) para a refatoração em camadas não mudar nada sem querer.
import { db } from "@/lib/db";

type Fn = () => void | Promise<void>;
interface TestCase { name: string; fn: Fn }

const tests: TestCase[] = [];
const prefix: string[] = [];
const beforeEachFns: { depth: number; fn: Fn }[] = [];
const afterEachFns: { depth: number; fn: Fn }[] = [];

export function describe(name: string, fn: () => void) {
  prefix.push(name);
  const depth = prefix.length;
  fn();
  // hooks registrados dentro do describe valem só para os testes dele
  for (let i = beforeEachFns.length - 1; i >= 0; i--) if (beforeEachFns[i].depth === depth) beforeEachFns.splice(i, 1);
  for (let i = afterEachFns.length - 1; i >= 0; i--) if (afterEachFns[i].depth === depth) afterEachFns.splice(i, 1);
  prefix.pop();
}

export function beforeEach(fn: Fn) {
  beforeEachFns.push({ depth: prefix.length, fn });
}
export function afterEach(fn: Fn) {
  afterEachFns.push({ depth: prefix.length, fn });
}

export function it(name: string, fn: Fn) {
  const befores = beforeEachFns.map((b) => b.fn);
  const afters = afterEachFns.map((a) => a.fn);
  tests.push({
    name: [...prefix, name].join(" › "),
    fn: async () => {
      for (const b of befores) await b();
      try {
        await fn();
      } finally {
        for (const a of afters.reverse()) await a();
      }
    },
  });
}

// ---------------- asserções ----------------

export class AssertionError extends Error {}

function show(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Set ? [...x] : x instanceof Map ? [...x] : x));
  } catch {
    return String(v);
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function expect<T>(actual: T) {
  const fail = (msg: string) => {
    throw new AssertionError(msg);
  };
  return {
    toBe(exp: T) {
      if (!Object.is(actual, exp)) fail(`esperado ${show(exp)}, veio ${show(actual)}`);
    },
    toEqual(exp: unknown) {
      if (!deepEqual(actual, exp)) fail(`esperado ${show(exp)},\n   veio ${show(actual)}`);
    },
    toBeTruthy() {
      if (!actual) fail(`esperado verdadeiro, veio ${show(actual)}`);
    },
    toBeFalsy() {
      if (actual) fail(`esperado falso, veio ${show(actual)}`);
    },
    toBeNull() {
      if (actual !== null) fail(`esperado null, veio ${show(actual)}`);
    },
    toBeUndefined() {
      if (actual !== undefined) fail(`esperado undefined, veio ${show(actual)}`);
    },
    toContain(item: unknown) {
      const ok = typeof actual === "string" ? actual.includes(item as string) : (actual as unknown[]).some((x) => deepEqual(x, item));
      if (!ok) fail(`${show(actual)} não contém ${show(item)}`);
    },
    notToContain(item: unknown) {
      const ok = typeof actual === "string" ? actual.includes(item as string) : (actual as unknown[]).some((x) => deepEqual(x, item));
      if (ok) fail(`${show(actual)} contém ${show(item)}`);
    },
    toBeGreaterThan(n: number) {
      if (!((actual as number) > n)) fail(`${show(actual)} não é > ${n}`);
    },
    toBeLessThan(n: number) {
      if (!((actual as number) < n)) fail(`${show(actual)} não é < ${n}`);
    },
    async toReject() {
      try {
        await (actual as Promise<unknown>);
      } catch {
        return;
      }
      fail("esperado erro, a promessa resolveu");
    },
    /** Golden master: compara com test/__snapshots__/<arquivo>.json (grava na 1ª vez). */
    toMatchSnapshot(name: string) {
      snapshotCompare(name, actual);
    },
  };
}

// ---------------- snapshots ----------------

let snapStore: Record<string, unknown> = {};
const snapNew: Record<string, unknown> = {};
let currentTest = "";
const UPDATE = new URLSearchParams(location.search).get("update") === "1";

/** Troca o que muda a cada execução (uids aleatórios) por um marcador. */
export function normalize(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (k, x) => {
      if ((k === "uid" || k === "reviewUid") && typeof x === "string") return "<uid>";
      if (x instanceof Set) return [...x];
      if (x instanceof Map) return [...x];
      return x;
    }),
  );
}

function snapshotCompare(name: string, actual: unknown) {
  const key = `${currentTest} :: ${name}`;
  const value = normalize(actual);
  if (!UPDATE && key in snapStore) {
    if (!deepEqual(snapStore[key], value)) {
      throw new AssertionError(`snapshot "${name}" mudou:\n   antes ${show(snapStore[key])}\n   agora ${show(value)}`);
    }
    return;
  }
  snapNew[key] = value;
}

// ---------------- relógio e acaso controlados ----------------

const RealDate = Date;
const realRandom = Math.random;
let fakeNow: number | null = null;

class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(fakeNow ?? RealDate.now());
    else super(...(args as [number]));
  }
  static now() {
    return fakeNow ?? RealDate.now();
  }
}

/** Congela o relógio (`Date.now()` e `new Date()`) em `ms`. */
export function setClock(ms: number) {
  fakeNow = ms;
  (globalThis as { Date: DateConstructor }).Date = FakeDate as unknown as DateConstructor;
}
export function advanceClock(ms: number) {
  if (fakeNow == null) throw new Error("relógio não congelado");
  fakeNow += ms;
}
export function restoreClock() {
  fakeNow = null;
  (globalThis as { Date: DateConstructor }).Date = RealDate;
}
/** Instante local (fuso do Chrome = TZ do run.mjs). */
export function at(y: number, mo: number, d: number, h = 12, mi = 0): number {
  return new RealDate(y, mo - 1, d, h, mi).getTime();
}

/** `Math.random` determinístico (LCG) até `restoreRandom`. */
export function seedRandom(seed = 42) {
  let s = seed >>> 0;
  Math.random = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
export function restoreRandom() {
  Math.random = realRandom;
}

// ---------------- banco ----------------

export async function resetDb() {
  if (!db.isOpen()) await db.open();
  await db.transaction("rw", db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
}

// ---------------- DOM ----------------

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeout = 4000, what = "condição"): Promise<T> {
  const t0 = RealDate.now();
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (RealDate.now() - t0 > timeout) {
      throw new AssertionError(`timeout esperando ${what}${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
    }
    await sleep(25);
  }
}

/** Elemento cujo texto (normalizado) é exatamente `text` (ou contém, com `partial`). */
export function queryByText(root: ParentNode, text: string, opts: { partial?: boolean; selector?: string } = {}): HTMLElement | null {
  const all = Array.from(root.querySelectorAll<HTMLElement>(opts.selector ?? "*"));
  // o mais interno que casa
  const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
  const hits = all.filter((el) => (opts.partial ? norm(el.textContent).includes(text) : norm(el.textContent) === text));
  return hits.find((el) => !hits.some((o) => o !== el && el.contains(o))) ?? null;
}
export function findByText(root: ParentNode, text: string, opts: { partial?: boolean; selector?: string; timeout?: number } = {}) {
  return waitFor(() => queryByText(root, text, opts), opts.timeout ?? 4000, `"${text}"`);
}
export function byLabel(root: ParentNode, label: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`);
}
export function textOf(el: Element | null): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}
export function press(key: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

// ---------------- execução ----------------

export async function runAll() {
  try {
    snapStore = await (await fetch("/__snapshots")).json();
  } catch {
    snapStore = {};
  }
  const grep = new URLSearchParams(location.search).get("grep");
  const results: { name: string; ok: boolean; error?: string; ms: number }[] = [];
  for (const t of tests) {
    if (grep && !t.name.includes(grep)) continue;
    currentTest = t.name;
    const t0 = RealDate.now();
    try {
      await t.fn();
      results.push({ name: t.name, ok: true, ms: RealDate.now() - t0 });
    } catch (e) {
      const err = e as Error;
      results.push({
        name: t.name, ok: false, ms: RealDate.now() - t0,
        error: err instanceof AssertionError ? err.message : `${err?.stack ?? err}`,
      });
    } finally {
      restoreClock();
      restoreRandom();
    }
  }
  await fetch("/__results", {
    method: "POST",
    body: JSON.stringify({ results, snapshots: snapNew, update: UPDATE }),
  });
}
