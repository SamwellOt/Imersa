// Regra pura do player de imersão: velocidades, a legenda em tela e a do Prime,
// o alvo da pausa do Prime e a base das URLs de mídia. Sem React, sem DOM.
import type { Segment } from "@/types/dose";

export const RATES = [0.7, 0.85, 1, 1.15, 1.35];

// Prime: 0,1 s antes de cada fala o vídeo pausa e mostra o significado em PT
// (idioma nativo). O aluno lê, dá play e ouve a fala em idioma-alvo "às cegas".
export const PRIME_LEAD_MS = 100;

/** A próxima velocidade acima da atual — uma velocidade persistida que não está
 *  mais na lista (versão antiga) não cai em -1 nem pula para 0,7×. */
export function nextRate(current: number): number {
  return RATES.find((r) => r > current + 1e-6) ?? RATES[0];
}

/** 1 → "1", 1.15 → "1.15", 0.7 → "0.7". */
export function formatRate(rate: number): string {
  return rate.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * "Sticky" current line (persists through the small gaps between lines so
 * captions don't flicker) + the 0.1s "prime window" before the next line — ou a
 * fala em que o Prime pausou (`primeHold`), enquanto ela ainda não começou.
 */
export function pickLines(
  segments: Segment[],
  cur: number,
  activeIndex: number,
  primeHold: Segment | null,
): { line: Segment | null; primeSeg: Segment | null } {
  const i = activeIndex; // already sticky (holds current/most-recent line)
  const ln: Segment | null = i >= 0 ? segments[i] : null;
  let nxt: Segment | null = null;
  for (let k = Math.max(0, i); k < segments.length; k++) {
    if (segments[k].startMs > cur) {
      nxt = segments[k];
      break;
    }
  }
  // prime window: within 0.1s before the next line begins — ou a fala em que
  // o Prime pausou, enquanto ela ainda não começou
  const prime = nxt && nxt.startMs - cur <= PRIME_LEAD_MS ? nxt : null;
  const held = primeHold && cur < primeHold.startMs ? primeHold : null;
  return { line: ln, primeSeg: prime ?? held };
}

/**
 * A próxima fala cuja janela do Prime ainda não passou (ao retomar da pausa, a
 * fala que acabou de ser lida fica para trás e o alvo vira a seguinte).
 */
export function nextPrimeTarget(
  segments: Segment[],
  cur: number,
  pausedId: string | null,
  wantsPrime: (s: Segment) => boolean,
): Segment | undefined {
  return segments.find(
    (s) => s.startMs - PRIME_LEAD_MS > cur + 30 && s.id !== pausedId && wantsPrime(s),
  );
}

/** Base das URLs dos arquivos da dose: a URL da mídia sem o `media.src` do fim. */
export function assetBaseOf(mediaUrl: string, mediaSrc: string): string {
  return mediaUrl.slice(0, Math.max(0, mediaUrl.length - mediaSrc.length));
}
