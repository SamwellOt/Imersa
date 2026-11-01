// Medidor de imersão: UMA regra de tempo ouvido para o vídeo e para a Escuta.
//
// Núcleo sem React. Escuta sozinho os eventos do elemento de mídia (playing, pause,
// waiting, seeking, timeupdate, ended) e da página (pagehide, visibilitychange). A regra:
//   • o intervalo é medido pelo relógio de parede enquanto a mídia toca de fato
//     (abre em `playing`, fecha em waiting/seeking/pause/ended) — a velocidade (1,5×)
//     não muda o valor, a aba em segundo plano conta e o buffering não;
//   • cada amostra credita no máximo 2 s: um aparelho que dorme com a mídia
//     "tocando" não credita a hora inteira;
//   • acumulado abaixo de 500 ms não grava (toque acidental);
//   • grava ao pausar/terminar, ao esconder a aba, no pagehide, a cada 60 s e ao
//     descartar o medidor.
// A gravação é um evento imutável (`logImmersion` → `immersionLog`).
import { logImmersion } from "./srsRepo";

/** Teto de crédito por amostra: o que passar disso é sono/suspensão, não estudo. */
export const METER_CAP_MS = 2000;
/** Abaixo disso o acumulado não vira evento. */
export const METER_MIN_MS = 500;
/** Intervalo máximo entre gravações enquanto a página está aberta. */
export const METER_FLUSH_MS = 60_000;

export interface ImmersionMeterOptions {
  /** Elemento <audio>/<video> cujos eventos o medidor escuta. */
  media: HTMLMediaElement;
  /** Idioma e lição de cada gravação, lidos na hora de gravar. */
  context: () => { language: string; doseId?: string };
  /** Relógio de parede em ms (injetável nos testes). */
  now?: () => number;
  /** Observa cada crédito (ms) — o player usa para avisar quanto ouviu. */
  onCredit?: (ms: number) => void;
}

export interface ImmersionMeter {
  /** Para de ouvir, grava o pendente e libera os eventos. */
  dispose(): void;
}

export function createImmersionMeter(opts: ImmersionMeterOptions): ImmersionMeter {
  const { media } = opts;
  const now = opts.now ?? Date.now;
  let lastTick: number | null = null; // relógio da última amostra com o intervalo aberto
  // intervalo aberto = a mídia está de fato tocando: abre em `playing`, fecha em
  // waiting/seeking/pause/ended. Buffering não conta como ouvido.
  let open = false;
  let pending = 0; // ms creditados e ainda não gravados
  let lastFlushAt = now();
  let disposed = false;

  const sample = () => {
    if (disposed) return;
    const t = now();
    if (lastTick != null) {
      const gap = t - lastTick;
      if (gap > 0) {
        const credit = Math.min(gap, METER_CAP_MS);
        pending += credit;
        opts.onCredit?.(credit);
      }
    }
    lastTick = open && !media.paused && !media.ended ? t : null;
    if (t - lastFlushAt >= METER_FLUSH_MS) flush();
  };

  const flush = () => {
    lastFlushAt = now();
    if (pending < METER_MIN_MS) return;
    const { language, doseId } = opts.context();
    if (!language) return;
    const ms = Math.round(pending);
    pending = 0;
    void logImmersion(language, ms, doseId);
  };

  const onPlaying = () => {
    // `playing` volta depois de um buffering: se o intervalo já está aberto, mantém
    open = true;
    if (lastTick == null) lastTick = now();
  };
  /** Fecha o intervalo: o que tocou até aqui conta, o parado e o buffering não. */
  const close = () => {
    sample();
    open = false;
    lastTick = null;
  };
  const onStop = () => {
    // pausar e acabar gravam já: o aparelho pode matar a aba sem aviso depois
    close();
    flush();
  };
  const onHide = () => {
    sample();
    flush();
  };
  // celular mata a aba sem `pagehide`: esconder a página também grava o pendente
  const onVisibility = () => {
    if (document.visibilityState === "hidden") onHide();
  };

  media.addEventListener("playing", onPlaying);
  media.addEventListener("timeupdate", sample);
  media.addEventListener("waiting", close);
  media.addEventListener("seeking", close);
  media.addEventListener("pause", onStop);
  media.addEventListener("ended", onStop);
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    dispose() {
      if (disposed) return;
      sample();
      flush();
      disposed = true;
      media.removeEventListener("playing", onPlaying);
      media.removeEventListener("timeupdate", sample);
      media.removeEventListener("waiting", close);
      media.removeEventListener("seeking", close);
      media.removeEventListener("pause", onStop);
      media.removeEventListener("ended", onStop);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
