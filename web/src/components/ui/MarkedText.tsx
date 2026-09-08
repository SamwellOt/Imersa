import type { Segment } from "@/types/dose";
import { markSpans, type LemmaStatus, type WordStatus } from "@/lib/vocab";
import { cn } from "@/lib/utils";

/**
 * Fala com as palavras marcadas pelo que o aluno sabe delas. Só sublinhado, a
 * cor do texto não muda — legenda é para ler. Fixada = limpa (é o normal);
 * em aprendizado = filete na cor "aprendendo" do SRS; nunca estudada = filete
 * pontilhado na cor de card novo. Sem tokens, devolve o texto puro.
 */
export const MARK_CLS: Record<WordStatus, string> = {
  known: "",
  learning: "underline decoration-hard decoration-2 underline-offset-[0.28em]",
  new: "underline decoration-accent decoration-dotted decoration-2 underline-offset-[0.28em]",
};

export function MarkedText({ seg, status }: { seg: Segment; status: LemmaStatus | null | undefined }) {
  const spans = markSpans(seg, status);
  if (spans.length === 1 && spans[0].status == null) return <>{seg.target}</>;
  return (
    <>
      {spans.map((sp, i) =>
        sp.status && sp.status !== "known" ? (
          <span key={i} className={cn(MARK_CLS[sp.status])}>{sp.text}</span>
        ) : (
          <span key={i}>{sp.text}</span>
        ),
      )}
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
