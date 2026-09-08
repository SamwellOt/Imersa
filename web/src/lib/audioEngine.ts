// A single shared <audio> element that can play a [start,end] range of any media
// URL. Used by SRS flashcards to play a card's sentence clip out of the dose's
// main audio without cutting per-card files.

let el: HTMLAudioElement | null = null;
let stopAt = Infinity;
let raf = 0;
// Carregar/seek é assíncrono: sem um token de geração, o `loadedmetadata` de um
// pedido antigo chegava depois de `stop()` (ou depois de o card já ter trocado)
// e tocava o áudio errado por cima do novo.
let gen = 0;
// Listeners de um pedido em voo. Se a mídia nunca carrega (404, codec ruim), o
// `loadedmetadata`/`seeked` nunca dispara e o listener ficava pendurado no
// elemento para sempre — um por card revisado, sessão adentro.
let pending: Array<[keyof HTMLMediaElementEventMap, EventListener]> = [];

function ensure(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
  }
  return el;
}

function clearPending() {
  if (!el) return;
  for (const [type, fn] of pending) el.removeEventListener(type, fn);
  pending = [];
}

function once(a: HTMLAudioElement, type: keyof HTMLMediaElementEventMap, fn: () => void) {
  const wrapped: EventListener = () => {
    a.removeEventListener(type, wrapped);
    pending = pending.filter(([, f]) => f !== wrapped);
    fn();
  };
  pending.push([type, wrapped]);
  a.addEventListener(type, wrapped);
}

function tick() {
  if (!el) return;
  // stop at the range end, or when a whole file finishes playing
  if (el.currentTime * 1000 >= stopAt || el.ended) {
    if (!el.ended) el.pause();
    stopAt = Infinity;
    cancelAnimationFrame(raf);
    return;
  }
  raf = requestAnimationFrame(tick);
}

export function playRange(url: string, startMs: number, endMs: number, rate = 1): void {
  const a = ensure();
  cancelAnimationFrame(raf);
  clearPending(); // o pedido anterior perdeu a vez
  stopAt = endMs;
  a.playbackRate = rate;
  const mine = ++gen; // este pedido é o único válido a partir de agora

  const begin = () => {
    if (mine !== gen) return;
    const startAt = Math.max(0, startMs / 1000);
    const doPlay = () => {
      if (mine !== gen) return;
      a.play().catch(() => {});
      raf = requestAnimationFrame(tick);
    };
    // Wait for the seek to land before playing, so we never play the wrong part.
    if (Math.abs(a.currentTime - startAt) > 0.05) {
      once(a, "seeked", doPlay);
      a.currentTime = startAt;
    } else {
      doPlay();
    }
  };

  if (a.src !== url && !a.src.endsWith(url)) {
    a.src = url;
    once(a, "loadedmetadata", begin);
    once(a, "error", clearPending); // mídia quebrada: solta o pedido em vez de esperar para sempre
    a.load();
  } else {
    begin();
  }
}

/** Play a whole audio file (e.g. a word's TTS clip) from start to end. */
export function playFile(url: string, rate = 1): void {
  playRange(url, 0, Number.POSITIVE_INFINITY, rate);
}

export function stop(): void {
  gen++; // invalida qualquer load/seek ainda em voo
  cancelAnimationFrame(raf);
  clearPending();
  stopAt = Infinity;
  el?.pause();
}
