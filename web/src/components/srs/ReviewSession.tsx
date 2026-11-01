// Tela da sessão de revisão (fase da dose e revisão avulsa). A regra mora em
// lib/reviewSession; aqui só o que aparece e o que se clica (lê a visão, chama comandos).
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
  const s = useReviewSession({ language, introduce, onDone });

  const faultLine = s.falha && (
    <p role="alert" className="mx-auto mb-4 w-full max-w-xl text-center text-[0.8125rem] text-again">
      {s.falha}
    </p>
  );

  const header = (
    <div className="mx-auto mb-7 w-full max-w-xl">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
        <div className="flex items-baseline gap-3 tabular-nums">
          <Count n={s.faltam.new} label="novos" active={s.tipoAtual === "new"} />
          <Count n={s.faltam.learning} label="aprendendo" active={s.tipoAtual === "learning"} />
          <Count n={s.faltam.review} label="a revisar" active={s.tipoAtual === "review"} />
        </div>
        <div className="flex items-baseline gap-3">
          {s.podeDesfazer && (
            <button
              onClick={() => void s.undo()}
              className="inline-flex items-center gap-1 text-faint transition-colors hover:text-fg"
              title="Desfazer a última nota (Z)"
            >
              <Undo2 size={12} /> Desfazer
            </button>
          )}
          <span className="text-faint tabular-nums">{s.resumo.reviewed} feitos</span>
        </div>
      </div>
      <ProgressBar value={s.resumo.reviewed} max={s.resumo.reviewed + s.restam} />
    </div>
  );

  // Mesmo aviso para a fila vazia e para o fim da fila com a cota estourada.
  const heldBackNotice = (
    <div className="mx-auto max-w-lg pt-6">
      <EmptyState
        title="Você já fez suas palavras novas de hoje"
        description={`Faltam ${s.heldBack} ${pluralize(s.heldBack, "palavra", "palavras")} desta dose. Elas entram amanhã, quando a cota virar — o método é uma dose por dia. Até lá, dá para rever o vídeo ou os cards já vencidos.`}
      />
    </div>
  );

  const retryButton = (
    <Button
      onClick={() => void s.retry()}
    >
      Conferir de novo
    </Button>
  );

  if (s.estado === "carregando") return <LoadingScreen label="Montando sua revisão…" />;

  if (s.estado === "cota") {
    // Cota estourada: a dose não fecha (senão as palavras novas que faltam somem da
    // trilha). Com falha ao conferir, mostra o erro e o "Conferir de novo" junto.
    if (!s.falha) return heldBackNotice;
    return (
      <div>
        {heldBackNotice}
        <div className="mx-auto mt-4 flex max-w-xl flex-col items-center gap-2">
          {faultLine}
          {retryButton}
        </div>
      </div>
    );
  }

  if (s.estado === "conferindo") return <LoadingScreen label="Conferindo a fila…" />;

  if (s.estado === "fim" && s.vazia) {
    // nada para estudar desde o início
    if (s.falha) {
      return (
        <div className="mx-auto max-w-lg pt-6">
          <EmptyState
            title="Não deu para montar a revisão"
            description={s.falha}
            action={<Button onClick={() => void s.reload()}>Tentar de novo</Button>}
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
              <Button onClick={() => void s.close()} disabled={s.fechando}>
                Concluir
              </Button>
            ) : undefined
          }
        />
        {s.erroAoFechar && <p role="alert" className="mt-4 text-center text-[0.8125rem] text-again">{s.erroAoFechar}</p>}
      </div>
    );
  }

  if (s.estado === "fim") {
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
          {s.resumo.reviewed} {s.resumo.reviewed === 1 ? "card revisado" : "cards revisados"}
          {s.resumo.newLearned > 0 && ` · ${s.resumo.newLearned} ${s.resumo.newLearned === 1 ? "palavra nova" : "palavras novas"}`}
          {s.resumo.again > 0 && ` · ${s.resumo.again} ${s.resumo.again === 1 ? "esquecido" : "esquecidos"}`}
        </p>
        {s.falha && !s.fechado && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <p className="text-[0.8125rem] text-again">{s.falha}</p>
            {retryButton}
          </div>
        )}
        {onDone == null && (
          <div className="mt-6 flex flex-col items-center gap-2">
            {s.pending > 0 && (
              /* Venceu durante a sessão. Não emendo sozinho: reiniciar a tela
                 na cara de quem acabou de terminar seria hostil. */
              <Button onClick={() => void s.reload()}>
                Revisar mais {s.pending} {s.pending === 1 ? "card" : "cards"}
              </Button>
            )}
            <Button
              variant={s.pending > 0 ? "ghost" : "secondary"}
              onClick={() => window.history.back()}
            >
              Voltar
            </Button>
          </div>
        )}
      </motion.div>
    );
  }

  const atual = s.atual!;
  return (
    <div className="flex flex-col items-center pt-2">
      {header}
      {faultLine}
      <Flashcard
        key={atual.uid}
        card={atual.card}
        rec={atual.rec}
        isNew={atual.isNew}
        settings={s.settings ?? undefined}
        mediaUrl={atual.mediaUrl}
        wordAudioUrl={atual.wordAudioUrl}
        fragmentUrl={atual.fragmentUrl}
        sceneUrl={atual.sceneUrl}
        example={atual.example}
        onGrade={(rating, elapsed) => void s.grade(rating, elapsed)}
        onAction={atual.rec ? (a) => void s.act(a) : undefined}
        onKnown={
          !isSentenceCard(atual.card) && (atual.isNew || atual.rec?.state === State.New)
            ? () => void s.known()
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
