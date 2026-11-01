import type { Segment } from "@/types/dose";
import type { LemmaStatus } from "@/lib/vocab";
import type { SubtitleMode } from "@/lib/store";
import { MarkLegend, type OnWord } from "@/components/ui/MarkedText";
import { TranscriptList } from "./TranscriptList";

/**
 * Transcrição: coluna ao lado do vídeo a partir de lg (colapsável — fechada, o
 * vídeo ocupa o centro); abaixo disso é o painel que o ícone abre por baixo dos
 * controles.
 */
export function TranscriptPanel({
  segments, activeIndex, onSeek, subtitleMode, marks, unclear, onWord, knownPct,
}: {
  segments: Segment[];
  activeIndex: number;
  onSeek: (i: number) => void;
  subtitleMode: SubtitleMode;
  marks: LemmaStatus | null;
  unclear: Set<string>;
  onWord?: OnWord;
  /** % das ocorrências já fixadas (com as marcas ligadas), ou null. */
  knownPct: number | null;
}) {
  return (
    <aside
      className="flex max-h-[46vh] flex-col overflow-hidden rounded-xl border border-line bg-surface lg:sticky lg:top-20 lg:max-h-[calc(100dvh-7rem)]"
      aria-label="Transcrição"
    >
      <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <span className="text-[0.8125rem] font-semibold">Transcrição</span>
        <span className="text-[0.6875rem] text-faint">
          {segments.length} falas
          {knownPct != null && `, ${knownPct}% já fixado`}
          {unclear.size > 0 && `, ${unclear.size} não ${unclear.size === 1 ? "entendida" : "entendidas"}`}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <TranscriptList
          segments={segments}
          activeIndex={activeIndex}
          onSeek={onSeek}
          showTranslation={subtitleMode !== "target" && subtitleMode !== "off"}
          marks={marks}
          unclear={unclear}
          onWord={onWord}
        />
      </div>
      {marks && (
        <div className="border-t border-line px-4 py-2.5">
          <MarkLegend />
        </div>
      )}
    </aside>
  );
}
