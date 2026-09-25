import type { Segment } from "@/types/dose";
import { markSpans, type LemmaStatus, type WordStatus } from "@/lib/vocab";
import { cn } from "@/lib/utils";

/**
 * Fala com as palavras marcadas pelo que o aluno sabe delas. Só sublinhado, a
 * cor do texto não muda — legenda é para ler. Fixada = limpa (é o normal);
 * em aprendizado = filete na cor "aprendendo" do SRS; nunca estudada = filete
 * pontilhado na cor de card novo. Sem tokens, devolve o texto puro.
 *
 * Com `onWord`, cada palavra de conteúdo vira um alvo de toque (dicionário da
 * dose): o sublinhado continua sendo só das marcas, o toque não muda o visual.
 */
export const MARK_CLS: Record<WordStatus, string> = {
  known: "",
  learning: "underline decoration-hard decoration-2 underline-offset-[0.28em]",
  new: "underline decoration-accent decoration-dotted decoration-2 underline-offset-[0.28em]",
};

export type OnWord = (lemma: string, seg: Segment, anchor: HTMLElement) => void;

export function MarkedText({
  seg, status, onWord,
}: {
  seg: Segment;
  /** Status por lema; `null`/`undefined` = marcas desligadas. */
  status: LemmaStatus | null | undefined;
  onWord?: OnWord;
}) {
  if (!status && !onWord) return <>{seg.target}</>;
  const spans = markSpans(seg, status);
  if (spans.length === 1 && spans[0].status == null && !spans[0].lemma) return <>{seg.target}</>;
  return (
    <>
      {spans.map((sp, i) => {
        const cls = status && sp.status && sp.status !== "known" ? MARK_CLS[sp.status] : "";
        if (onWord && sp.lemma) {
          const lemma = sp.lemma;
          return (
            <span
              key={i}
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onWord(lemma, seg, e.currentTarget);
              }}
              className={cn("word-tap", cls)}
            >
              {sp.text}
            </span>
          );
        }
        return <span key={i} className={cls || undefined}>{sp.text}</span>;
      })}
    </>
  );
}

/** Legenda das marcas — aparece junto da legenda quando o destaque está ligado. */
export function MarkLegend({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3 text-[0.6875rem] text-faint", className)}>
      <span><span className={MARK_CLS.learning}>aprendendo</span></span>
      <span><span className={MARK_CLS.new}>nunca estudada</span></span>
    </span>
  );
}
