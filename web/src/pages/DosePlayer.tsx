import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ArrowRight, Check, Headphones } from "lucide-react";
import { resolveDose, loadCourseByLanguage, loadDose, langOfDoseId } from "@/lib/content";
import { useAsync, useDocumentTitle } from "@/lib/hooks";
import { useApp } from "@/lib/store";
import {
  getDoseProgress, markPhaseDone, saveMediaPosition, getMediaPosition, completeDose, nextDose,
  getAllProgress, getOverview,
} from "@/lib/progress";
import { logImmersion, countDueElsewhere } from "@/lib/srs";
import { ImmersionPlayer } from "@/components/player/ImmersionPlayer";
import { ReviewSession, type ReviewSummary } from "@/components/srs/ReviewSession";
import { LoadingScreen, ErrorScreen } from "@/components/ui/feedback";
import { Button, SectionLabel } from "@/components/ui/primitives";
import { LogoMark } from "@/components/ui/Logo";
import { cn, fmtClock, pluralize } from "@/lib/utils";
import { BRAND } from "@/lib/brand";

type Phase = "prime" | "immersion" | "review" | "done";
const STEPS: { id: Phase; label: string }[] = [
  { id: "prime", label: "Prime" },
  { id: "immersion", label: "Imersão" },
  { id: "review", label: "Revisão" },
];

// A fase vive na URL (?fase=…): recarregar mantém o lugar, o botão Voltar do
// navegador anda entre as fases em vez de sair da dose, e dá para linkar
// direto para a imersão de uma dose já concluída.
const PHASE_BY_SLUG: Record<string, Phase> = {
  prime: "prime",
  imersao: "immersion",
  revisao: "review",
  fim: "done",
};
const SLUG_BY_PHASE: Record<Phase, string> = {
  prime: "prime",
  immersion: "imersao",
  review: "revisao",
  done: "fim",
};

/** Etapas da dose: rótulos de texto com filete no ativo — sem pílulas coloridas. */
function Stepper({
  phase,
  onJump,
  block,
}: {
  phase: Phase;
  onJump: (p: Phase) => void;
  block?: boolean;
}) {
  const order: Phase[] = ["prime", "immersion", "review"];
  const idx = order.indexOf(phase === "done" ? "review" : phase);
  return (
    <nav className={cn("flex items-center", block && "w-full")} aria-label="Etapas da dose">
      {STEPS.map((s, i) => {
        const active = i === idx && phase !== "done";
        const done = i < idx || phase === "done";
        return (
          <button
            key={s.id}
            onClick={() => onJump(s.id)}
            aria-current={active ? "step" : undefined}
            className={cn(
              "relative px-2 py-2 text-xs font-medium transition-colors",
              block && "flex-1 justify-center py-2.5",
              active ? "text-fg" : done ? "text-muted hover:text-fg" : "text-faint hover:text-muted",
            )}
          >
            <span className="inline-flex items-center gap-1">
              {done && <Check size={11} strokeWidth={3} className="text-good" />}
              {s.label}
            </span>
            {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-brand" />}
          </button>
        );
      })}
    </nav>
  );
}

export function DosePlayer() {
  const { doseId } = useParams();
  const nav = useNavigate();
  const activeLanguage = useApp((s) => s.activeLanguage);
  const lang = langOfDoseId(doseId) ?? activeLanguage;
  const [params, setParams] = useSearchParams();
  const urlPhase = PHASE_BY_SLUG[params.get("fase") ?? ""] ?? null;
  const [phase, setPhaseState] = useState<Phase | null>(urlPhase);
  // resumo da fase de revisão, usado no fecho da dose
  const [summary, setSummary] = useState<ReviewSummary | null>(null);

  const setPhase = (p: Phase) => {
    setPhaseState(p);
    setParams({ fase: SLUG_BY_PHASE[p] });
  };

  const { data, loading, error, reload } = useAsync(async () => {
    if (!lang || !doseId) throw new Error("Sessão inválida");
    const resolved = await resolveDose(lang, doseId);
    // só leitura: abrir a dose não cria linha de progresso (ver `markPhaseDone`)
    const prog = await getDoseProgress(doseId);
    return { ...resolved, resumeMs: await getMediaPosition(doseId), completed: prog?.completed ?? false };
  }, [lang, doseId]);

  useDocumentTitle(data ? `${data.dose.title} · ${BRAND.name}` : BRAND.name);

  // Sem fase na URL: dose já concluída abre direto na imersão (rever o vídeo é
  // o motivo de reabrir), o resto começa no Prime.
  useEffect(() => {
    if (phase != null || !data) return;
    const initial: Phase = data.completed ? "immersion" : "prime";
    setPhaseState(initial);
    setParams({ fase: SLUG_BY_PHASE[initial] }, { replace: true });
  }, [data, phase, setParams]);

  // "?fase=fim" só vale para dose concluída (antes, ou agora nesta sessão):
  // colada numa lição nunca feita, a URL mostrava "Dose concluída" à toa.
  useEffect(() => {
    if (phase !== "done" || !data || data.completed || summary) return;
    setPhaseState("prime");
    setParams({ fase: SLUG_BY_PHASE.prime }, { replace: true });
  }, [phase, data, summary, setParams]);

  // Botão voltar/avançar do navegador → acompanha a fase.
  useEffect(() => {
    if (urlPhase && urlPhase !== phase) setPhaseState(urlPhase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPhase]);

  // Tempo de imersão: acumula em memória e vira evento no banco ao trocar de
  // fase, ao sair da dose e a cada minuto. O `lang` vem de uma ref porque o
  // flush do unmount roda com a closure do primeiro render — sem a ref, fechar
  // a dose perderia os minutos assistidos.
  const listenedRef = useRef(0);
  const langRef = useRef(lang);
  langRef.current = lang;
  const doseIdRef = useRef(doseId);
  doseIdRef.current = doseId;
  const flushListened = () => {
    const l = langRef.current;
    if (l && listenedRef.current > 500) {
      logImmersion(l, listenedRef.current, doseIdRef.current);
      listenedRef.current = 0;
    }
  };
  const flushRef = useRef(flushListened);
  flushRef.current = flushListened;
  useEffect(() => {
    // fechar a aba no meio do vídeo também precisa registrar o que já rodou
    const onHide = () => flushRef.current();
    addEventListener("pagehide", onHide);
    const every = setInterval(onHide, 60_000);
    return () => {
      removeEventListener("pagehide", onHide);
      clearInterval(every);
      flushRef.current();
    };
  }, []);
  useEffect(() => {
    if (phase !== "immersion") flushListened();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // A posição do vídeo é salva no máximo a cada 5s. Antes o corte era feito
  // pelo valor do tempo (`ms % 5000`), e como o player emite a posição a cada
  // quadro isso gravava ~15 vezes seguidas na mesma janela — enxurrada de
  // escritas no IndexedDB e de mudanças para a sincronização carregar.
  // Começa "já salvo": ao montar, o player reporta 0 antes de aplicar o seek de
  // retomada — gravar esse 0 apagava justamente a posição que o aluno tinha.
  const lastSavedAt = useRef(Date.now());

  // O erro vem antes da fase: sem `?fase` na URL a fase só é decidida quando a
  // dose carrega — com a dose inexistente ela nunca era, e a tela ficava presa
  // em "Abrindo a dose…" para sempre.
  if (loading) return <LoadingScreen label="Abrindo a dose…" />;
  if (error || !data || !lang) return <ErrorScreen message={error?.message ?? "Erro"} onRetry={reload} backHome />;
  if (phase == null) return <LoadingScreen label="Abrindo a dose…" />;

  const { dose, mediaUrl, path, resumeMs } = data;

  const goImmersion = () => {
    void markPhaseDone(dose.id, lang, "prime");
    setPhase("immersion");
  };
  const goReview = () => {
    void markPhaseDone(dose.id, lang, "immersion");
    setPhase("review");
  };
  // As duas escritas são esperadas em ordem antes de trocar de fase: o fecho
  // precisa estar gravado quando a tela final montar, senão ela lê o progresso
  // de antes e mostra a sequência sem contar a dose que acabou de sair.
  const finishDose = async (s: ReviewSummary) => {
    setSummary(s);
    try {
      await markPhaseDone(dose.id, lang, "review");
      await completeDose(dose.id, lang);
    } finally {
      setPhase("done");
    }
  };

  return (
    <div className="min-h-dvh">
      {/* Barra superior */}
      {/* No celular o título e as três etapas não cabem na mesma linha — as
          etapas descem para uma faixa própria, com alvo de toque inteiro. */}
      <div className="bar-solid pt-safe sticky top-0 z-30 border-b border-line">
        <div className={cn("mx-auto px-4", phase === "immersion" ? "max-w-[1160px]" : "max-w-3xl")}>
          <div className="flex items-center gap-3">
            <button
              onClick={() => nav("/")}
              className="-ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg md:ml-0 md:h-8 md:w-8 text-faint transition-colors hover:bg-surface-2 hover:text-fg"
              aria-label="Sair da dose"
            >
              <X size={16} />
            </button>
            <div className="min-w-0 flex-1 py-2.5">
              <div className="truncate text-[0.8125rem] font-medium">{dose.title}</div>
              <div className="text-[0.6875rem] text-faint">
                {dose.level} · {BRAND.unit} {dose.lessonNumber}
              </div>
            </div>
            <div className="hidden sm:block">
              <Stepper phase={phase} onJump={(p) => setPhase(p)} />
            </div>
          </div>
          <div className="-mt-0.5 sm:hidden">
            <Stepper phase={phase} onJump={(p) => setPhase(p)} block />
          </div>
        </div>
      </div>

      <div
        className={cn(
          "mx-auto px-5 py-6 pb-[max(2rem,env(safe-area-inset-bottom))] md:py-8",
          phase === "immersion" ? "max-w-[1160px]" : "max-w-3xl",
        )}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22 }}
          >
            {phase === "prime" && <PrimePhase dose={dose} onNext={goImmersion} />}

            {phase === "immersion" && (
              <div className="flex flex-col gap-5">
                <ImmersionPlayer
                  dose={dose}
                  mediaUrl={mediaUrl}
                  initialMs={resumeMs}
                  onListened={(d) => (listenedRef.current += d)}
                  onPositionChange={(ms) => {
                    const now = Date.now();
                    if (ms < 1000 || now - lastSavedAt.current < 5000) return;
                    lastSavedAt.current = now;
                    void saveMediaPosition(dose.id, ms);
                  }}
                  // Assistiu até o fim: a próxima abertura começa do zero. Sem
                  // isso a posição salva era o último segundo, e o Hoje dizia
                  // "Retoma o vídeo em 18:18".
                  onEnded={() => {
                    lastSavedAt.current = Date.now();
                    void saveMediaPosition(dose.id, 0);
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
                  <p className="text-sm text-muted">
                    Assistiu até o fim? As {dose.cards.length} palavras da dose vêm agora.
                  </p>
                  <Button onClick={goReview}>
                    Ir para a revisão <ArrowRight size={15} />
                  </Button>
                </div>
              </div>
            )}

            {phase === "review" && (
              <ReviewSession
                language={lang}
                introduce={dose}
                onDone={finishDose}
                emptyHint="Sem cards pendentes desta dose por agora."
              />
            )}

            {phase === "done" && (
              <DonePhase language={lang} coursePath={path} doseId={dose.id} summary={summary} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function PrimePhase({ dose, onNext }: { dose: Parameters<typeof ImmersionPlayer>[0]["dose"]; onNext: () => void }) {
  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="label-eyebrow text-faint">Prime · leia antes de ouvir</p>
        <h2 className="font-display mt-2.5 text-[1.75rem] leading-snug md:text-[2rem]">
          {dose.title}
        </h2>
        {dose.titleTarget && (
          <p className="font-target mt-1.5 text-base text-muted">{dose.titleTarget}</p>
        )}
        <p className="mt-5 max-w-[62ch] leading-relaxed text-muted">{dose.synopsis}</p>
      </header>

      {dose.premise && (
        <div className="border-l-2 border-brand/40 pl-4">
          <p className="label-eyebrow text-faint">Contexto</p>
          <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-muted">{dose.premise}</p>
        </div>
      )}

      {dose.primePreview.length > 0 && (
        <section>
          <SectionLabel>O que você vai ouvir</SectionLabel>
          <ol className="mt-4">
            {dose.primePreview.map((chunk, i) => (
              <motion.li
                key={chunk.id}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: Math.min(i * 0.025, 0.3) }}
                className="flex gap-4 border-t border-line py-3 last:border-b"
              >
                <span className="timecode w-10 shrink-0 pt-0.5 text-faint">
                  {fmtClock(chunk.startMs)}
                </span>
                <p className="text-[0.9375rem] leading-relaxed text-muted">{chunk.summary}</p>
              </motion.li>
            ))}
          </ol>
        </section>
      )}

      {/* CTA fixa no rodapé, com o conteúdo esmaecendo por baixo em vez de
          simplesmente passar atrás do botão. */}
      <div
        className="sticky bottom-0 -mx-5 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-6"
        style={{ background: "linear-gradient(to top, var(--bg) 65%, transparent)" }}
      >
        <Button size="lg" block onClick={onNext}>
          Começar a imersão <ArrowRight size={16} />
        </Button>
      </div>
    </div>
  );
}

function DonePhase({
  language,
  doseId,
  summary,
}: {
  language: string;
  coursePath: string;
  doseId: string;
  summary: ReviewSummary | null;
}) {
  const nav = useNavigate();
  const { data } = useAsync(async () => {
    const course = await loadCourseByLanguage(language);
    const progress = await getAllProgress(language);
    // A fase de revisão agora só cobre esta dose — então o fecho precisa dizer
    // o que ficou pendente das outras, senão o vencido some da vista.
    const dueElsewhere = await countDueElsewhere(language, doseId);
    const overview = await getOverview(language);
    const ref = course.doses.find((d) => d.id === doseId);
    const condensed = ref ? !!(await loadDose(language, ref.path).catch(() => null))?.media.condensedAudioSrc : false;
    return { next: nextDose(course, progress), doneId: doseId, dueElsewhere, overview, condensed };
  }, [language, doseId]);

  const streak = data?.overview.streak.current ?? 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mx-auto max-w-sm pt-16 text-center"
    >
      <LogoMark size={32} className="mx-auto" />
      <h2 className="font-display mt-6 text-[1.75rem] leading-tight">Dose concluída</h2>
      <p className="mx-auto mt-2.5 max-w-[36ch] text-sm leading-relaxed text-muted">
        Prime, imersão e revisão — o ciclo completo. Volte amanhã para manter a sequência.
      </p>

      {/* O que a dose rendeu, em número: fecho sem comemoração vazia. Só quando
          a revisão aconteceu nesta sessão — reabrir a URL ?fase=fim não pode
          exibir "0 palavras novas". */}
      {summary && (
        <dl className="mt-7 grid grid-cols-3 divide-x divide-line border-y border-line py-4 text-center">
          <div>
            <dd className="text-lg font-semibold tabular-nums">{summary.newLearned}</dd>
            <dt className="mt-0.5 text-[0.6875rem] leading-tight text-faint">
              {pluralize(summary.newLearned, "palavra nova", "palavras novas")}
            </dt>
          </div>
          <div>
            <dd className="text-lg font-semibold tabular-nums">{summary.reviewed}</dd>
            <dt className="mt-0.5 text-[0.6875rem] leading-tight text-faint">
              {pluralize(summary.reviewed, "card revisado", "cards revisados")}
            </dt>
          </div>
          <div>
            <dd className="text-lg font-semibold tabular-nums">{streak}</dd>
            <dt className="mt-0.5 text-[0.6875rem] leading-tight text-faint">
              {pluralize(streak, "dia seguido", "dias seguidos")}
            </dt>
          </div>
        </dl>
      )}
      {(data?.dueElsewhere ?? 0) > 0 && (
        <div className="mt-7 border-t border-line pt-5 text-sm">
          <p className="text-muted">
            Ainda há{" "}
            <span className="font-semibold text-fg tabular-nums">{data!.dueElsewhere}</span>{" "}
            {data!.dueElsewhere === 1 ? "card vencido" : "cards vencidos"} de outras doses.
          </p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => nav("/review")}>
            Revisar agora
          </Button>
        </div>
      )}

      <div className="mt-8 flex flex-col items-center gap-2">
        {data?.next ? (
          <Button size="lg" onClick={() => nav(`/dose/${data.next!.id}`)}>
            Próxima dose <ArrowRight size={16} />
          </Button>
        ) : (
          <Button size="lg" onClick={() => nav("/review")}>
            Revisar mais cards
          </Button>
        )}
        {data?.condensed && (
          <Button variant="ghost" onClick={() => nav(`/escuta/${doseId}`)}>
            <Headphones size={15} /> Reouvir em áudio condensado
          </Button>
        )}
        <Button variant="ghost" onClick={() => nav("/")}>
          Voltar ao início
        </Button>
      </div>
    </motion.div>
  );
}
