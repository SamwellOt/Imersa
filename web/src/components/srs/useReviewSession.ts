// Ligação da sessão de revisão (lib/reviewSession) com a tela: a visão entra por
// `useSyncExternalStore`, e o relógio da revisão avulsa (cards que vencem sozinhos)
// e o atalho Z ficam aqui. A regra da sessão mora no módulo, sem React.
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { Dose } from "@/types/dose";
import { createReviewSession, type ReviewSummary } from "@/lib/reviewSession";
import { useDueTick, useDueCount } from "@/lib/useDue";
import { useHotkeys, isTypingTarget } from "@/lib/hooks";

export type { ReviewSummary } from "@/lib/reviewSession";

export function useReviewSession({
  language,
  introduce,
  onDone,
}: {
  language: string;
  introduce?: Dose;
  onDone?: (summary: ReviewSummary) => void | Promise<void>;
}) {
  const standalone = onDone == null;
  // o fecho pode mudar de identidade a cada render da tela; a sessão lê a versão atual
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const session = useMemo(
    () =>
      createReviewSession({
        language,
        introduce,
        onDone: standalone ? undefined : (s) => onDoneRef.current?.(s),
      }),
    // a sessão é uma por idioma/dose/modo; a mudança de qualquer um recomeça a fila
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language, introduce?.id, standalone],
  );

  useEffect(() => {
    void session.start();
    return () => session.dispose();
  }, [session]);

  const view = useSyncExternalStore(session.subscribe, session.getView);

  // Revisão avulsa: a tela acorda sozinha quando um card vence. Na fase da dose
  // não — a fila é fechada e terminar significa fim da lição.
  const tick = useDueTick(standalone ? language : null);
  const dueNow = useDueCount(standalone ? language : null);
  /** Vencidos que ainda não estão na fila montada. */
  const pending = standalone ? Math.max(0, dueNow - view.restam) : 0;

  // Fila vazia + algo venceu = recarrega sem pedir nada ao aluno.
  useEffect(() => {
    if (!standalone || tick === 0) return;
    if (view.estado !== "carregando" && view.total === 0 && dueNow > 0) void session.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, dueNow]);

  useHotkeys((e) => {
    if (isTypingTarget(e) || e.repeat) return;
    // Ctrl+Z / Z desfaz, como no Anki
    if (e.key.toLowerCase() === "z" && !e.altKey && view.podeDesfazer) {
      e.preventDefault();
      void session.undo();
    }
  });

  return {
    ...view,
    pending,
    grade: session.grade,
    known: session.known,
    undo: session.undo,
    act: session.act,
    close: session.close,
    reload: session.reload,
    retry: session.retry,
  };
}
