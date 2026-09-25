import { useCallback, useEffect, useRef, useState } from "react";
import type { Segment } from "@/types/dose";

/** Quanto tempo a legenda de uma fala sobrevive depois do `endMs` dela. */
const STICKY_MS = 1500;

export interface MediaController {
  mediaRef: React.RefObject<HTMLMediaElement>;
  playing: boolean;
  currentMs: number;
  durationMs: number;
  activeIndex: number; // index into segments, -1 if none
  ready: boolean;
  /** Mídia falhou ao carregar (404, codec não suportado…). */
  error: boolean;
  /** Recarrega a mídia depois de um erro. */
  retry: () => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seekMs: (ms: number) => void;
  seekBy: (deltaMs: number) => void;
  setRate: (r: number) => void;
  goToSegment: (i: number) => void;
  nextSegment: () => void;
  prevSegment: () => void;
  replaySegment: () => void;
}

/**
 * Wraps an <audio>/<video> element: tracks time, resolves the active segment,
 * handles line-level navigation and an optional single-segment loop.
 * Also reports listened time (playing wall-clock) via onListened.
 */
export function useMediaController(
  segments: Segment[],
  opts: {
    rate?: number;
    loopSegment?: boolean;
    initialMs?: number;
    onListened?: (deltaMs: number) => void;
    onTimeUpdate?: (ms: number) => void;
    /** A mídia chegou ao fim (o `ended` do elemento). */
    onEnded?: () => void;
  } = {},
): MediaController {
  const mediaRef = useRef<HTMLMediaElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(opts.initialMs ?? 0);
  const [durationMs, setDurationMs] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  const ptrRef = useRef(0); // search hint
  const loopRef = useRef(opts.loopSegment ?? false);
  loopRef.current = opts.loopSegment ?? false;
  const lastTickRef = useRef<number | null>(null);
  const onListenedRef = useRef(opts.onListened);
  onListenedRef.current = opts.onListened;
  const onTimeRef = useRef(opts.onTimeUpdate);
  onTimeRef.current = opts.onTimeUpdate;
  const onEndedRef = useRef(opts.onEnded);
  onEndedRef.current = opts.onEnded;

  const resolveActive = useCallback(
    (ms: number): number => {
      const n = segments.length;
      if (n === 0) return -1;
      let i = ptrRef.current;
      if (i >= n) i = n - 1;
      // move backward if needed
      while (i > 0 && ms < segments[i].startMs) i--;
      // move forward while past current segment end and next has started
      while (i < n - 1 && ms >= segments[i + 1].startMs) i++;
      ptrRef.current = i;
      const seg = segments[i];
      if (ms >= seg.startMs && ms <= seg.endMs) return i;
      // between segments: report the upcoming/previous boundary as inactive
      if (ms < seg.startMs) return -1;
      if (ms > seg.endMs) {
        // A linha continua "ativa" um pouco depois de acabar, para a legenda não
        // piscar nos vãos curtos entre falas — mas só por STICKY_MS. Sem o teto,
        // a fala de 0:01 ficava na tela até a próxima começar em 0:24, por cima
        // da vinheta do vídeo, e a transcrição destacava a linha errada.
        const sticky = ms - seg.endMs <= STICKY_MS;
        if (sticky && (i === n - 1 || ms < segments[i + 1].startMs)) return i;
        return -1;
      }
      return i;
    },
    [segments],
  );

  /**
   * Sincroniza tempo, legenda ativa, loop de linha e tempo ouvido.
   *
   * O rAF só roda **enquanto está tocando** — antes ele girava para sempre,
   * queimando CPU/bateria com o vídeo parado. Com a mídia pausada, `seeked` e
   * `timeupdate` bastam para manter a legenda em dia.
   */
  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    let raf = 0;
    let running = false;

    const sync = () => {
      const ms = el.currentTime * 1000;
      setCurrentMs(ms);
      onTimeRef.current?.(ms);
      const idx = resolveActive(ms);
      setActiveIndex((prev) => (prev === idx ? prev : idx));

      // loop de uma linha só
      if (loopRef.current && idx >= 0) {
        const seg = segments[idx];
        if (ms >= seg.endMs - 20) el.currentTime = seg.startMs / 1000;
      }

      // Contabiliza tempo ouvido (relógio de parede enquanto toca).
      //
      // O intervalo entre amostras é creditado com TETO em vez de descartado:
      // em segundo plano o rAF para e o `timeupdate` cai para ~1 por segundo, e
      // o corte antigo (`d < 1000`) jogava fora exatamente essas amostras — quem
      // ouvia com a aba atrás não somava minuto nenhum. O teto continua
      // protegendo do outro lado: aparelho que suspende por uma hora e volta
      // credita 2 s, não a hora inteira.
      if (!el.paused) {
        const now = performance.now();
        if (lastTickRef.current != null) {
          const d = now - lastTickRef.current;
          if (d > 0) onListenedRef.current?.(Math.min(d, 2000));
        }
        lastTickRef.current = now;
      } else {
        lastTickRef.current = null;
      }
    };

    const loop = () => {
      sync();
      if (el.paused) {
        running = false;
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(loop);
    };

    el.addEventListener("play", start);
    el.addEventListener("playing", start);
    el.addEventListener("seeked", sync);
    el.addEventListener("timeupdate", sync);
    el.addEventListener("loadedmetadata", sync);
    sync();
    if (!el.paused) start();

    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("play", start);
      el.removeEventListener("playing", start);
      el.removeEventListener("seeked", sync);
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("loadedmetadata", sync);
    };
  }, [resolveActive, segments]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onMeta = () => {
      setDurationMs(el.duration * 1000);
      setReady(true);
      if (opts.initialMs && opts.initialMs > 0) el.currentTime = opts.initialMs / 1000;
    };
    const onError = () => setError(true);
    const onLoadStart = () => setError(false);
    const onEnded = () => onEndedRef.current?.();
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("loadedmetadata", onMeta);
    el.addEventListener("error", onError);
    el.addEventListener("loadstart", onLoadStart);
    if (el.readyState >= 1) onMeta();
    return () => {
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeEventListener("error", onError);
      el.removeEventListener("loadstart", onLoadStart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !opts.rate) return;
    // o default também: `load()` (o "tentar de novo" depois de um erro) volta
    // `playbackRate` ao `defaultPlaybackRate`, e o vídeo retomava em 1×
    el.defaultPlaybackRate = opts.rate;
    el.playbackRate = opts.rate;
  }, [opts.rate]);

  const retry = useCallback(() => {
    setError(false);
    mediaRef.current?.load();
  }, []);
  const play = useCallback(() => void mediaRef.current?.play().catch(() => {}), []);
  const pause = useCallback(() => mediaRef.current?.pause(), []);
  const toggle = useCallback(() => {
    const el = mediaRef.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }, []);
  const seekMs = useCallback((ms: number) => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, ms / 1000);
    setCurrentMs(ms);
  }, []);
  const seekBy = useCallback((delta: number) => {
    const el = mediaRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, el.currentTime + delta / 1000);
  }, []);
  const setRate = useCallback((r: number) => {
    if (!mediaRef.current) return;
    mediaRef.current.defaultPlaybackRate = r;
    mediaRef.current.playbackRate = r;
  }, []);
  const goToSegment = useCallback(
    (i: number) => {
      if (i < 0 || i >= segments.length) return;
      seekMs(segments[i].startMs);
      ptrRef.current = i;
      setActiveIndex(i);
    },
    [segments, seekMs],
  );
  const nextSegment = useCallback(() => {
    const i = ptrRef.current;
    goToSegment(Math.min(segments.length - 1, i + 1));
  }, [goToSegment, segments.length]);
  const prevSegment = useCallback(() => {
    const el = mediaRef.current;
    const i = ptrRef.current;
    // if we're >1.2s into the line, restart it; else go to previous
    if (el && i >= 0 && el.currentTime * 1000 - segments[i].startMs > 1200) {
      goToSegment(i);
    } else {
      goToSegment(Math.max(0, i - 1));
    }
  }, [goToSegment, segments]);
  const replaySegment = useCallback(() => {
    const i = ptrRef.current;
    if (i >= 0) {
      goToSegment(i);
      play();
    }
  }, [goToSegment, play]);

  return {
    mediaRef,
    playing,
    currentMs,
    durationMs,
    activeIndex,
    ready,
    error,
    retry,
    play,
    pause,
    toggle,
    seekMs,
    seekBy,
    setRate,
    goToSegment,
    nextSegment,
    prevSegment,
    replaySegment,
  };
}
