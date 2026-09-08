/*
  Service worker do Imersa — offline-first para o app e para o conteúdo leve.

  Regra que manda: **vídeo nunca passa por aqui.** Arquivos de dose têm dezenas
  de MB e são pedidos com `Range` (seek). Um SW que devolvesse a resposta inteira
  do cache quebraria o arrastar da barra de progresso e estouraria a cota. Então
  `.mp4`/`.webm` e qualquer requisição com `Range` vão direto para a rede.

  O que fica offline: o app (JS/CSS/HTML), os JSONs de conteúdo e os clipes
  curtos de áudio dos cards (TTS da palavra + fragmento da frase).
*/
const VERSION = "imersa-v4"; // v4: /otimizar fora do shell + `cache: "reload"` honrado; v3: capas/cenas offline; v2: assets com COEP
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const PRECACHE = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

const isMedia = (url) => /\.(mp4|webm|mov|m4v)$/i.test(url.pathname);
const isShortAudio = (url) => /\.(mp3|m4a|ogg|wav)$/i.test(url.pathname);
// capa da dose e cena de cada card (`media/frames/*.jpg`): pequenas e imutáveis (nome com hash)
const isContentImage = (url) => url.pathname.startsWith("/content/") && /\.(jpe?g|png|webp)$/i.test(url.pathname);
const isAsset = (url) => url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/");
const isContentJson = (url) => url.pathname.startsWith("/content/") && url.pathname.endsWith(".json");
const isFont = (url) =>
  url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && (res.ok || res.type === "opaque")) cache.put(request, res.clone());
  return res;
}

/**
 * Purga do SHELL os `/assets/` que o index.html novo não referencia mais.
 *
 * O nome dos assets tem hash, então cada build gera arquivos novos e os velhos
 * ficariam no cache para sempre — o `activate` não resolve, porque ele só roda
 * quando o próprio sw.js muda, e este arquivo é estático. Como o index.html é
 * network-first, toda visita online traz a lista atual: é dela que sai o que
 * pode ir embora.
 */
async function pruneAssets(html) {
  const keep = new Set();
  for (const m of html.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)) keep.add(m[0]);
  if (!keep.size) return; // HTML inesperado: não apaga nada por precaução
  const cache = await caches.open(SHELL);
  for (const req of await cache.keys()) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/assets/") && !keep.has(pathname)) await cache.delete(req);
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  // `cache: "reload"` no fetch = o app quer a fonte, não a cópia (é como a
  // revisão confere se uma dose sumiu MESMO antes de apagar registro órfão).
  // Rede primeiro; um 404 aí é resposta de verdade. Sem rede, cai na cópia.
  if (request.cache === "reload") {
    try {
      const res = await fetch(request);
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      return (await cache.match(request)) || Response.error();
    }
  }
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);
  return hit || (await network) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  // Seek de mídia: deixa passar direto, senão o Range quebra.
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && isMedia(url)) return; // vídeo: sempre da rede

  // Navegação: rede primeiro (pega o index.html novo depois de um build),
  // cache como rede de segurança offline.
  if (request.mode === "navigate") {
    // /otimizar é OUTRA página (otimizar.html, com assets próprios). Guardá-la
    // como "/index.html" trocava o shell offline pelo otimizador, e a poda
    // apagava o bundle do app — offline, o Imersa abria na tela de otimizar.
    const isShell = !url.pathname.startsWith("/otimizar");
    event.respondWith(
      fetch(request)
        .then((res) => {
          // só guarda página boa: um 503 "app não buildado" virava o shell
          // offline permanente do aparelho
          if (res.ok && isShell) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/index.html", copy));
            // e joga fora os assets do build anterior, que ninguém mais pede
            res.clone().text().then(pruneAssets).catch(() => {});
          }
          return res;
        })
        .catch(async () => (await caches.match("/index.html")) || Response.error()),
    );
    return;
  }

  if (!sameOrigin && !isFont(url)) return;

  if (isAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL)); // hash no nome = imutável
  } else if (isContentJson(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME)); // regerar dose atualiza sozinho
  } else if (sameOrigin && (isShortAudio(url) || isContentImage(url))) {
    event.respondWith(cacheFirst(request, RUNTIME)); // TTS, fragmentos, capas e cenas dos cards
  } else if (isFont(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME));
  }
});
