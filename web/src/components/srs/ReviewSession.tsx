// Tela da sessão de revisão (fase da dose e revisão avulsa). O estado e as
// ações moram em `useReviewSession`; aqui só o que aparece e o que se clica.
import { motion } from "framer-motion";
import { Check, Undo2 } from "lucide-react";
import { State } from "ts-fsrs";
import type { Dose } from "@/types/dose";
import { Flashcard } from "./Flashcard";
import { isSentenceCard } from "@/lib/cards";
import { useReviewSession, type ReviewSummary } from "./useReviewSession";
import { ProgressBar } from "@/components/ui/progress";
import { LoadingScreen, EmptyState } from "@/components/ui/feedback";
import { Button } from "@/components/ui/primitives";
import { cn, pluralize } from "@/lib/utils";

export type { ReviewSummary } from "./useReviewSession";

export function ReviewSession({
  language,
  introduce,
  onDone,
  emptyHint,
}: {
  language: string;
  introduce?: Dose; // dose review: offer this dose's unseen cards + due reviews
  onDone?: (summary: ReviewSummary) => void | Promise<void>;
  emptyHint?: string;
}) {
  const {
    settings, items, heldBack, pos, summary, fault, setFault, settledFor, setSettledFor, setRecheck,
    doneFired, total, current, finished, pending, history, remaining, currentKind,
    loadMore, onGrade, onKnown, undo, onAction, closing, closeError, concludeEmpty,
  } = useReviewSession({ language, introduce, onDone });

  const faultLine = fault && (
    <p role="alert" className="mx-auto mb-4 w-full max-w-xl text-center text-[0.8125rem] text-again">
      {fault}
    </p>
  );

  const header = (
    <div className="mx-auto mb-7 w-full max-w-xl">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
        <div className="flex items-baseline gap-3 tabular-nums">
          <Count n={remaining.new} label="novos" active={currentKind === "new"} />
          <Count n={remaining.learning} label="aprendendo" active={currentKind === "learning"} />
          <Count n={remaining.review} label="a revisar" active={currentKind === "review"} />
        </div>
        <div className="flex items-baseline gap-3">
          {history.length > 0 && (
            <button
              onClick={undo}
              className="inline-flex items-center gap-1 text-faint transition-colors hover:text-fg"
              title="Desfazer a última nota (Z)"
            >
              <Undo2 size={12} /> Desfazer
            </button>
          )}
          <span className="text-faint tabular-nums">{summary.reviewed} feitos</span>
        </div>
      </div>
      <ProgressBar value={summary.reviewed} max={summary.reviewed + (total - pos)} />
    </div>
  );

  // Mesmo aviso para a fila vazia e para o fim da fila com a cota estourada.
  const heldBackNotice = (
    <div className="mx-auto max-w-lg pt-6">
      <EmptyState
        title="Você já fez suas palavras novas de hoje"
        description={`Faltam ${heldBack} ${pluralize(heldBack, "palavra", "palavras")} desta dose. Elas entram amanhã, quando a cota virar — o método é uma dose por dia. Até lá, dá para rever o vídeo ou os cards já vencidos.`}
      />
    </div>
  );

  if (items == null) return <LoadingScreen label="Montando sua revisão…" />;

  if (total === 0 && !finished) {
    // Teto do dia estourado: as palavras desta dose existem e nunca foram
    // vistas — a fila só está vazia porque a cota acabou. Fechar a dose aqui
    // marcaria como concluída uma lição com zero palavras aprendidas, e ela
    // sumiria da trilha para sempre. Então nada de "Concluir": a dose fica
    // pendente e o aluno sai pelo X da barra de cima.
    if (heldBack > 0) return heldBackNotice;
    if (fault) {
      return (
        <div className="mx-auto max-w-lg pt-6">
          <EmptyState
            title="Não deu para montar a revisão"
            description={fault}
            action={<Button onClick={loadMore}>Tentar de novo</Button>}
          />
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-lg pt-6">
        <EmptyState
          title={onDone ? "Cards desta dose já revisados hoje" : "Nada para revisar agora"}
          description={
            emptyHint ??
            "Você está em dia. Os cards aparecem aqui sozinhos quando vencerem — não precisa recarregar."
          }
          action={
            onDone ? (
              <Button onClick={concludeEmpty} disabled={closing}>
                Concluir
              </Button>
            ) : undefined
          }
        />
        {closeError && <p role="alert" className="mt-4 text-center text-[0.8125rem] text-again">{closeError}</p>}
      </div>
    );
  }

  if (finished) {
    if (settledFor !== total) return <LoadingScreen label="Conferindo a fila…" />;
    if (heldBack > 0) {
      // Cota estourada E falha ao conferir: mostra o erro e o "Conferir de novo"
      // junto do aviso (sem o fault, a tela escondia o motivo e o botão).
      if (!fault) return heldBackNotice;
      return (
        <div>
          {heldBackNotice}
          <div className="mx-auto mt-4 flex max-w-xl flex-col items-center gap-2">
            {faultLine}
            <Button
              onClick={() => {
                setFault(null);
                setSettledFor(-1);
                setRecheck((n) => n + 1);
              }}
            >
              Conferir de novo
            </Button>
          </div>
        </div>
      );
    }
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-sm pt-14 text-center"
      >
        <div className="mx-auto grid h-9 w-9 place-items-center rounded-full border border-good/35 text-good">
          <Check size={16} strokeWidth={2.5} />
        </div>
        <h2 className="font-display mt-5 text-[1.5rem] leading-tight">Revisão concluída</h2>
        <p className="mt-2 text-sm text-muted">
          {summary.reviewed} {summary.reviewed === 1 ? "card revisado" : "cards revisados"}
          {summary.newLearned > 0 && ` · ${summary.newLearned} ${summary.newLearned === 1 ? "palavra nova" : "palavras novas"}`}
          {summary.again > 0 && ` · ${summary.again} ${summary.again === 1 ? "esquecido" : "esquecidos"}`}
        </p>
        {fault && !doneFired.current && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <p className="text-[0.8125rem] text-again">{fault}</p>
            <Button
              onClick={() => {
                setFault(null);
                setSettledFor(-1);
                setRecheck((n) => n + 1);
              }}
            >
              Conferir de novo
            </Button>
          </div>
        )}
        {onDone == null && (
          <div className="mt-6 flex flex-col items-center gap-2">
            {pending > 0 && (
              /* Venceu durante a sessão. Não emendo sozinho: reiniciar a tela
                 na cara de quem acabou de terminar seria hostil. */
              <Button onClick={loadMore}>
                Revisar mais {pending} {pending === 1 ? "card" : "cards"}
              </Button>
            )}
            <Button
              variant={pending > 0 ? "ghost" : "secondary"}
              onClick={() => window.history.back()}
            >
              Voltar
            </Button>
          </div>
        )}
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col items-center pt-2">
      {header}
      {faultLine}
      <Flashcard
        key={current!.uid}
        card={current!.card}
        rec={current!.rec}
        isNew={current!.isNew}
        settings={settings ?? undefined}
        mediaUrl={current!.mediaUrl}
        wordAudioUrl={current!.wordAudioUrl}
        fragmentUrl={current!.fragmentUrl}
        sceneUrl={current!.sceneUrl}
        example={current!.example}
        onGrade={(rating, elapsed) => onGrade(current!, rating, elapsed)}
        onAction={current!.rec ? (a) => onAction(current!, a) : undefined}
        onKnown={
          !isSentenceCard(current!.card) && (current!.isNew || current!.rec?.state === State.New)
            ? () => onKnown(current!)
            : undefined
        }
      />
    </div>
  );
}

function Count({ n, label, active }: { n: number; label: string; active: boolean }) {
  return (
    <span className={cn("transition-colors", active ? "text-fg" : "text-faint")} title={label}>
      <span className={cn("font-semibold", active ? "text-fg" : "text-muted")}>{n}</span>{" "}
      {label}
    </span>
  );
}
