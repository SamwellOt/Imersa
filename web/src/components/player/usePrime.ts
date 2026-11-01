import { useEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "@/types/dose";
import type { LemmaStatus } from "@/lib/vocab";
import type { SubtitleMode } from "@/lib/store";
import type { useMediaController } from "./useMediaController";
import { PRIME_LEAD_MS, nextPrimeTarget, pickLines } from "./playerLogic";

/**
 * Legenda em tela + modo Prime: a fala atual (com folga nos vãos), a fala do
 * Prime e as duas pausas (por relógio e, de reserva, por quadro).
 * `adaptive`/`lemmaStatus` só entram como dependências do efeito da pausa —
 * quem decide se uma fala pede Prime é `wantsPrime`.
 */
export function usePrime({
  segments, subtitleMode, ctl, wantsPrime, playbackRate, adaptive, lemmaStatus,
}: {
  segments: Segment[];
  subtitleMode: SubtitleMode;
  ctl: ReturnType<typeof useMediaController>;
  wantsPrime: (sg: Segment) => boolean;
  playbackRate: number;
  adaptive: boolean;
  lemmaStatus: LemmaStatus | null | undefined;
}) {
  // A fala para a qual o Prime pausou. A legenda em PT precisa aparecer pela
  // PAUSA, não pelo tempo do vídeo: o `setTimeout` (e o próprio `pause()`) param
  // uns milissegundos antes da janela de 100 ms, e aí `startMs − cur` dava 103,
  // a janela não abria e a tela mostrava "Dê play" sem legenda nenhuma. Fica
  // fixa até a fala começar (o áudio revela o que o aluno acabou de ler).
  const [primeHold, setPrimeHold] = useState<Segment | null>(null);

  // "Sticky" current line (persists through the small gaps between lines so
  // captions don't flicker) + the next line + the 0.1s "prime window" before it.
  const { line, primeSeg } = useMemo(
    () => pickLines(segments, ctl.currentMs, ctl.activeIndex, primeHold),
    [ctl.currentMs, ctl.activeIndex, segments, primeHold],
  );

  // a fala começou (ou o modo mudou): solta a legenda fixada
  useEffect(() => {
    if (primeHold && (subtitleMode !== "primed" || ctl.currentMs >= primeHold.startMs)) {
      setPrimeHold(null);
    }
  }, [primeHold, subtitleMode, ctl.currentMs]);

  // Prime mode: pause 0.1s before each line so the learner reads the target text,
  // then resumes to hear it (subtitle hides once the line starts).
  const primePausedRef = useRef<string | null>(null);
  // Por relógio: a pausa é um `setTimeout` calculado do tempo da mídia e da
  // velocidade até `startMs − 100 ms` da próxima fala. O caminho por quadro
  // (abaixo) dependia de um tique do rAF cair dentro da janela de 100 ms — com
  // a aba em segundo plano o rAF para, o `timeupdate` vem ~1×/s e a fala
  // passava sem pausar. Ele continua como reserva; a ref evita pausar duas vezes.
  useEffect(() => {
    if (subtitleMode !== "primed" || !ctl.playing) return;
    const el = ctl.mediaRef.current;
    if (!el) return;
    const cur = el.currentTime * 1000;
    // a próxima fala cuja janela ainda não passou (ao retomar da pausa, a fala
    // que acabou de ser lida fica para trás e o alvo vira a seguinte)
    const nxt = nextPrimeTarget(segments, cur, primePausedRef.current, wantsPrime);
    if (!nxt) return;
    const target = nxt.startMs - PRIME_LEAD_MS;
    const delay = (target - cur) / (el.playbackRate || 1);
    const t = setTimeout(() => {
      if (primePausedRef.current === nxt.id) return;
      primePausedRef.current = nxt.id;
      setPrimeHold(nxt);
      ctl.pause();
      // o timer chega uns ms antes ou depois do alvo: encosta o vídeo em
      // exatamente 0,1 s antes da fala, para o play retomar com a folga certa
      if (Math.abs(el.currentTime * 1000 - target) > 40) el.currentTime = target / 1000;
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleMode, ctl.playing, ctl.activeIndex, playbackRate, segments, adaptive, lemmaStatus]);
  useEffect(() => {
    if (subtitleMode !== "primed") {
      primePausedRef.current = null;
      return;
    }
    if (ctl.playing && primeSeg && primePausedRef.current !== primeSeg.id && wantsPrime(primeSeg)) {
      primePausedRef.current = primeSeg.id;
      setPrimeHold(primeSeg);
      ctl.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleMode, ctl.playing, primeSeg?.id]);

  return { line, primeSeg };
}
