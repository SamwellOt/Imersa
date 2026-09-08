import { useEffect, useRef } from "react";
import type { Segment } from "@/types/dose";
import { cn, fmtClock } from "@/lib/utils";
import type { LemmaStatus } from "@/lib/vocab";
import { MarkedText } from "@/components/ui/MarkedText";

export function TranscriptList({
  segments,
  activeIndex,
  onSeek,
  showTranslation,
  marks,
}: {
  segments: Segment[];
  activeIndex: number;
  onSeek: (i: number) => void;
  showTranslation: boolean;
  marks?: LemmaStatus | null;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);
  // O aluno rolou a lista com a mão? Deixa quieto por alguns segundos em vez de
  // puxar de volta a cada fala. O scroll programático também dispara `scroll`,
  // então ele é marcado para não contar como gesto.
  const userScrollAt = useRef(0);
  const autoScrollUntil = useRef(0);
  const USER_HOLD_MS = 4000;
  useEffect(() => {
    const box = activeRef.current?.closest<HTMLElement>(".overflow-y-auto");
    if (!box) return;
    const onScroll = () => {
      if (Date.now() > autoScrollUntil.current) userScrollAt.current = Date.now();
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => box.removeEventListener("scroll", onScroll);
  }, []);
  // Rola só a caixa da transcrição. `scrollIntoView` arrastava a PÁGINA junto:
  // com o vídeo tocando, a tela ficava pulando para a transcrição a cada fala.
  useEffect(() => {
    const el = activeRef.current;
    if (!el) return;
    if (Date.now() - userScrollAt.current < USER_HOLD_MS) return;
    const box = el.closest<HTMLElement>(".overflow-y-auto");
    if (!box) return;
    // delta por rects: não depende de qual ancestral é o `offsetParent`
    const eb = el.getBoundingClientRect();
    const bb = box.getBoundingClientRect();
    const delta = eb.top - bb.top - (bb.height - eb.height) / 2;
    autoScrollUntil.current = Date.now() + 800;
    box.scrollTo({ top: Math.max(0, box.scrollTop + delta), behavior: "smooth" });
  }, [activeIndex]);

  return (
    <div className="flex flex-col">
      {segments.map((seg, i) => {
        const active = i === activeIndex;
        return (
          <button
            key={seg.id}
            ref={active ? activeRef : undefined}
            onClick={() => onSeek(i)}
            className={cn(
              "group relative flex gap-3 rounded-lg px-3 py-2 text-left transition-colors",
              active ? "bg-surface-2" : "hover:bg-surface-2/60",
            )}
          >
            {active && (
              <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand" />
            )}
            <span
              className={cn(
                "timecode mt-[0.15rem] w-10 shrink-0",
                active ? "text-brand" : "text-faint",
              )}
            >
              {fmtClock(seg.startMs)}
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  "line-target text-[0.9375rem]",
                  active ? "text-fg" : "text-muted group-hover:text-fg",
                )}
              >
                {marks ? <MarkedText seg={seg} status={marks} /> : seg.target}
              </span>
              {showTranslation && seg.translation && (
                <span className="line-trans mt-0.5 block text-[0.875rem] text-faint">
                  {seg.translation}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
