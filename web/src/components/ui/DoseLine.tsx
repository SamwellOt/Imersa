import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { fmtClock } from "@/lib/utils";

/**
 * A linha da dose — o átomo visual do Imersa.
 *
 * Uma fala em idioma-alvo, a tradução embaixo e o timecode do lugar exato onde
 * ela acontece no vídeo. É a mesma peça no Hoje, no Prime, na transcrição e no
 * verso do card: o app inteiro é feito de linhas ancoradas no tempo do vídeo,
 * que é literalmente do que a metodologia é feita.
 */
export function DoseLine({
  startMs,
  target,
  translation,
  size = "md",
  scene,
  className,
  children,
}: {
  startMs?: number | null;
  target: ReactNode;
  translation?: ReactNode;
  size?: "md" | "lg";
  /** URL do quadro do vídeo naquele instante (a cena). Opcional. */
  scene?: string | null;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("flex gap-4", className)}>
      {scene ? (
        <img
          src={scene}
          alt=""
          loading="lazy"
          className="w-28 shrink-0 self-center rounded-md border border-line object-cover aspect-video md:w-32"
        />
      ) : (
        startMs != null && (
          <span className="timecode w-10 shrink-0 pt-[0.3rem] text-faint" aria-hidden>
            {fmtClock(startMs)}
          </span>
        )
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "line-target text-fg",
            size === "lg" ? "text-[1.25rem] md:text-[1.4375rem]" : "text-[0.9375rem]",
          )}
        >
          {target}
        </p>
        {translation && (
          <p
            className={cn(
              "line-trans mt-1 text-muted",
              size === "lg" ? "text-[1.0625rem] md:text-[1.125rem]" : "text-[0.9375rem]",
            )}
          >
            {translation}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
