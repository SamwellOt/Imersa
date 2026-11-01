import type { Segment } from "@/types/dose";
import type { LemmaStatus } from "@/lib/vocab";
import { MarkedText, type OnWord } from "@/components/ui/MarkedText";
import type { SubtitleMode } from "@/lib/store";
import { cn } from "@/lib/utils";

const TARGET_CLS =
  "line-target sub-target sub-shadow text-[1.375rem] font-medium md:text-[1.75rem]";

/**
 * Painel de legendas, logo abaixo da mídia.
 *
 * Fica FORA do componente do player de propósito: declarado dentro dele, o React
 * via um tipo de componente novo a cada quadro de vídeo e remontava o painel
 * inteiro ~60 vezes por segundo (texto piscando e trabalho de layout à toa).
 */
export function CaptionPanel({
  mode, line, primeSeg, playing, marks, onWord,
}: {
  mode: SubtitleMode;
  line: Segment | null;
  primeSeg: Segment | null;
  playing: boolean;
  /** Status por lema quando a legenda "conhecido/novo" está ligada; null = desligada. */
  marks: LemmaStatus | null;
  onWord?: OnWord;
}) {
  // A altura é reservada (min-h + centralização) para a troca de legenda não
  // empurrar os controles para baixo a cada fala.
  const box = "flex min-h-[7rem] flex-col items-center justify-center gap-2 text-center md:min-h-[8rem]";

  if (mode === "off") {
    return (
      <div className={box}>
        <span className="text-xs text-faint">Legendas desligadas</span>
      </div>
    );
  }

  if (mode === "primed") {
    // 0,1 s antes de cada fala o vídeo pausa e mostra o significado em PT; o
    // aluno lê, dá play e ouve a fala "às cegas" (a legenda some na hora dela).
    return (
      <div className={cn(box, "gap-2.5")}>
        {primeSeg ? (
          <>
            <span className="label-eyebrow text-brand">
              Prime{!playing && " · leia e dê play"}
            </span>
            <p className="sub-target sub-shadow max-w-2xl text-balance text-lg leading-snug md:text-xl">
              {primeSeg.translation || primeSeg.target}
            </p>
          </>
        ) : (
          <span className="text-xs text-faint">
            {playing ? "Ouvindo…" : "Dê play para continuar"}
          </span>
        )}
      </div>
    );
  }

  const showTarget = mode === "target" || mode === "both";
  const showTrans = mode === "translation" || mode === "both";
  return (
    <div className={box}>
      {line ? (
        <>
          {showTarget && (
            <p className={cn(TARGET_CLS, "text-balance")}>
              <MarkedText seg={line} status={marks} onWord={onWord} />
            </p>
          )}
          {showTrans && line.translation && (
            <p
              className={cn(
                "sub-shadow max-w-2xl text-balance leading-snug",
                showTarget
                  ? "sub-trans text-[0.9375rem] md:text-base"
                  : "sub-target text-lg font-medium md:text-xl",
              )}
            >
              {line.translation}
            </p>
          )}
        </>
      ) : (
        <span className="text-xs text-faint">· · ·</span>
      )}
    </div>
  );
}
