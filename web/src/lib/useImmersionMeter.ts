// Liga o medidor de imersão (lib/immersionMeter) a um elemento de mídia da tela.
import { useEffect, useRef, type RefObject } from "react";
import { createImmersionMeter, type ImmersionMeter } from "./immersionMeter";

export function useImmersionMeter(
  mediaRef: RefObject<HTMLMediaElement>,
  opts: { language: string; doseId?: string; onCredit?: (ms: number) => void },
): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const attached = useRef<{ media: HTMLMediaElement; meter: ImmersionMeter } | null>(null);

  // O elemento pode nascer ou trocar depois do primeiro render (o <audio> da
  // Escuta só existe quando o áudio já virou blob): confere a cada render.
  useEffect(() => {
    const el = mediaRef.current;
    if (attached.current?.media === el) return;
    attached.current?.meter.dispose();
    attached.current = el
      ? {
          media: el,
          meter: createImmersionMeter({
            media: el,
            context: () => ({ language: optsRef.current.language, doseId: optsRef.current.doseId }),
            onCredit: (ms) => optsRef.current.onCredit?.(ms),
          }),
        }
      : null;
  });

  // Desmontar a tela grava o que já tocou.
  useEffect(
    () => () => {
      attached.current?.meter.dispose();
      attached.current = null;
    },
    [],
  );
}
