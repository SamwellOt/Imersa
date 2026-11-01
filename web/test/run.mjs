#!/usr/bin/env node
// Runner dos testes do web/ — sem dependência nova:
//   1. empacota test/entry.tsx com o Vite (já é devDependency);
//   2. sobe um node:http com o bundle + a dose de fixture em /content;
//   3. abre o Chrome headless do sistema (IndexedDB e DOM de verdade);
//   4. a página manda os resultados por POST e o processo sai com 0/1.
//
// Uso: npm run test:web            (todos)
//      npm run test:web -- srs     (só os que contêm "srs" no nome)
//      UPDATE=1 npm run test:web   (regrava os snapshots dos testes que rodaram)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const outDir = join(here, ".out");
const fixtures = join(here, "fixtures");
const snapFile = join(here, "__snapshots__", "snapshots.json");
const grep = process.argv[2] ?? "";
const update = process.env.UPDATE === "1";

await build({
  configFile: false,
  root: here,
  logLevel: "warn",
  resolve: { alias: { "@": join(web, "src") } },
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  build: { outDir, emptyOutDir: true, minify: false, sourcemap: "inline", target: "es2022" },
});

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".css": "text/css" };
const readSnaps = () => (existsSync(snapFile) ? JSON.parse(readFileSync(snapFile, "utf8")) : {});

let finish;
const done = new Promise((r) => (finish = r));

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.end("ok");
      if (url.pathname === "/__results") finish(JSON.parse(body));
    });
    return;
  }
  if (url.pathname === "/__snapshots") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(readSnaps()));
  }
  const base = url.pathname.startsWith("/content/") ? fixtures : outDir;
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = normalize(join(base, decodeURIComponent(rel)));
  if (!file.startsWith(base) || !existsSync(file)) {
    res.statusCode = 404;
    return res.end("not found");
  }
  const data = readFileSync(file);
  res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  // Range simples para o <audio> poder buscar posição
  const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = +range[1];
    const end = range[2] ? +range[2] : data.length - 1;
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${end}/${data.length}`);
    res.setHeader("accept-ranges", "bytes");
    return res.end(data.subarray(start, end + 1));
  }
  res.end(data);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const chromeBin = ["/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find(existsSync);
if (!chromeBin) throw new Error("Chrome/Chromium não encontrado");
const profile = mkdtempSync(join(tmpdir(), "imersa-test-"));
const q = new URLSearchParams();
if (grep) q.set("grep", grep);
if (update) q.set("update", "1");
const chrome = spawn(chromeBin, [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--mute-audio",
  "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  `http://127.0.0.1:${port}/?${q}`,
], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TZ: "America/Sao_Paulo" } });
let chromeErr = "";
chrome.stderr.on("data", (c) => (chromeErr += c));

const timeout = setTimeout(() => finish({ timeout: true }), 180_000);
const out = await done;
clearTimeout(timeout);
chrome.kill("SIGKILL");
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { /* perfil em uso */ }

if (out.timeout) {
  console.error("timeout: a página não mandou resultados em 180 s\n" + chromeErr.slice(-2000));
  process.exit(1);
}

let fails = 0;
for (const r of out.results) {
  if (r.ok) console.log(`  ✔ ${r.name} (${r.ms} ms)`);
  else {
    fails++;
    console.log(`  ✖ ${r.name}\n     ${r.error.replace(/\n/g, "\n     ")}`);
  }
}
const newSnaps = Object.keys(out.snapshots);
if (newSnaps.length) {
  writeFileSync(snapFile, JSON.stringify({ ...readSnaps(), ...out.snapshots }, null, 1) + "\n");
  console.log(`  ${newSnaps.length} snapshot(s) ${out.update ? "regravado(s)" : "novo(s)"} em test/__snapshots__/`);
}
console.log(`\n${out.results.length - fails} passaram, ${fails} falharam`);
process.exit(fails ? 1 : 0);
