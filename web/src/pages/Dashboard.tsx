import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Play, Check, RotateCcw } from "lucide-react";
import { loadIndex, loadCourse, loadDose, mediaUrl } from "@/lib/content";
import { getAllProgress, nextDose, getOverview, getMediaPosition, dayIsActive } from "@/lib/progress";
import { countNewReady, countLearnAhead, mostOverdue } from "@/lib/srs";
import { dailyStats } from "@/lib/db";
import { loadLemmaStatus, lemmaOfCardId, coverage, knownShare, hasTokens, statusOf } from "@/lib/vocab";
import type { LemmaStatus } from "@/lib/vocab";
import { useDueCount } from "@/lib/useDue";
import { useAsync, useDocumentTitle, useMediaQuery } from "@/lib/hooks";
import { useApp } from "@/lib/store";
import { firstName, useAuth } from "@/lib/auth";
import { Card, Button } from "@/components/ui/primitives";
import { DoseLine } from "@/components/ui/DoseLine";
import { HomeSkeleton, ErrorScreen } from "@/components/ui/feedback";
import { fmtDuration, fmtClock, dayKey, shiftDay, pluralize, cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";
import type { Dose, DoseRef } from "@/types/dose";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "Boa madrugada";
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

// "sábado, 22 de agosto" → "Sábado, 22 de agosto" (capitalize erraria o "De")
const todayLabel = () => {
  const s = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * A fala de abertura da dose de hoje. É o que o aluno vai ouvir de verdade —
 * mostrar a língua em vez de um card de marketing é o que faz a tela "Hoje"
 * parecer a aula, e não um painel.
 */
function openingLine(dose: Dose | null) {
  if (!dose) return null;
  // A primeira fala com tradução (as primeiras podem ser vinheta sem legenda).
  const seg = dose.segments.find((s) => s.translation && s.target.trim().length > 1);
  return seg ?? dose.segments[0] ?? null;
}

/** Os sete últimos dias: estudei ou não estudei, e onde estamos na semana. */
function WeekStrip({
  days,
  streak,
  doneToday,
}: {
  days: { day: string; active: boolean }[];
  streak: number;
  doneToday: boolean;
}) {
  const today = dayKey();
  return (
    <div className="flex flex-col gap-1.5 sm:items-end sm:pt-1">
      <div className="flex gap-1" aria-hidden>
        {days.map((d) => {
          const isToday = d.day === today;
          return (
            <span
              key={d.day}
              className={cn(
                "h-3.5 w-3.5 rounded-[3px]",
                d.active ? (isToday && !doneToday ? "bg-brand/45" : "bg-brand") : "bg-surface-3",
                isToday && "outline outline-1 -outline-offset-1 outline-line-strong",
              )}
            />
          );
        })}
      </div>
      <span className="text-xs text-muted">
        {streak > 0 ? (
          <>
            <b className="font-semibold text-fg tabular-nums">
              {streak} {pluralize(streak, "dia", "dias")}
            </b>{" "}
            {streak === 1 ? "seguido" : "seguidos"}
            {!doneToday && ", a de hoje ainda não"}
          </>
        ) : (
          "Sua sequência começa hoje"
        )}
      </span>
    </div>
  );
}

/** A trilha inteira, em capas: feita em cor, atual com contorno, futura em cinza. */
function Trail({
  lang,
  doses,
  doneIds,
  currentId,
  total,
}: {
  lang: string;
  doses: DoseRef[];
  doneIds: Set<string>;
  currentId?: string;
  total: number;
}) {
  const nav = useNavigate();
  const doneCount = doneIds.size;
  // No celular, 7 capas em ~350 px viravam miniaturas ilegíveis: 4 por linha.
  const wide = useMediaQuery("(min-width: 640px)");
  const cols = wide ? Math.min(doses.length, 7) : Math.min(doses.length, 4);
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs text-muted">
        <span>
          <b className="font-semibold text-fg">Trilha {doses[0]?.level ?? ""}</b>, {doneCount} de{" "}
          {total} {pluralize(total, "concluída", "concluídas")}
        </span>
      </div>
      <div
        className="mt-2.5 grid gap-2"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {doses.map((d) => {
          const done = doneIds.has(d.id);
          const cur = d.id === currentId;
          const poster = d.posterSrc ? mediaUrl(lang, d.path, d.posterSrc) : null;
          return (
            <button
              key={d.id}
              onClick={() => nav(`/dose/${d.id}`)}
              title={d.title}
              aria-label={`${BRAND.unit} ${d.lessonNumber}: ${d.title}`}
              className={cn(
                "relative overflow-hidden rounded-md border border-line bg-surface-2 text-left transition-colors hover:border-line-strong",
                cur && "outline outline-2 -outline-offset-2 outline-brand",
              )}
            >
              {poster ? (
                <img
                  src={poster}
                  alt=""
                  loading="lazy"
                  className={cn("aspect-video w-full object-cover", !done && !cur && "opacity-40 grayscale")}
                />
              ) : (
                <div className="aspect-video w-full" />
              )}
              <span className="timecode absolute left-1.5 top-1 rounded-[3px] bg-black/65 px-1 text-[0.625rem] text-white">
                {String(d.lessonNumber).padStart(2, "0")}
              </span>
              {done && (
                <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-brand text-brand-fg">
                  <Check size={9} strokeWidth={3.5} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** As três fases da dose, com o peso real de cada uma. */
function Phases({ dose, phases }: { dose: Dose | DoseRef; phases: string[] }) {
  const isFull = (d: Dose | DoseRef): d is Dose => "segments" in d;
  const items = [
    { id: "prime", label: "Prime", hint: "leia antes", w: 3 },
    {
      id: "immersion",
      label: "Imersão",
      hint: `${fmtDuration(isFull(dose) ? dose.media.durationSec : dose.durationSec)} de vídeo`,
      w: 17,
    },
    {
      id: "review",
      label: "Revisão",
      hint: `${isFull(dose) ? dose.cards.length : dose.cardCount} palavras`,
      w: 6,
    },
  ];
  return (
    <div
      className="mt-4 grid gap-1"
      style={{ gridTemplateColumns: items.map((i) => `${i.w}fr`).join(" ") }}
    >
      {items.map((it) => {
        const done = phases.includes(it.id);
        return (
          <div
            key={it.id}
            className={cn("border-t-2 pt-1.5", done ? "border-brand" : "border-surface-3")}
          >
            <span className="block text-xs font-semibold text-fg">{it.label}</span>
            <span className="block truncate text-[0.6875rem] text-muted">{done ? "feito" : it.hint}</span>
          </div>
        );
      })}
    </div>
  );
}

/** As 20 palavras do dia, em idioma-alvo: a dose deixa de ser promessa abstrata. */
function VocabStrip({ dose, status }: { dose: Dose; status: LemmaStatus }) {
  const words = dose.cards.map((c) => ({
    text: c.target,
    st: statusOf(status, lemmaOfCardId(c.id) ?? ""),
  }));
  const seen = words.filter((w) => w.st !== "new").length;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[0.6875rem] text-faint">
        <span>As {words.length} palavras de hoje</span>
        {seen > 0 && (
          <span>
            {seen} {seen === 1 ? "já estudada" : "já estudadas"}
          </span>
        )}
      </div>
      <p className="font-target mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.9375rem] leading-relaxed text-muted">
        {words.map((w, i) => (
          <span
            key={i}
            className={cn(
              w.st === "known" && "border-b border-brand text-fg",
              w.st === "learning" && "border-b border-dotted border-brand text-fg",
            )}
          >
            {w.text}
          </span>
        ))}
      </p>
    </div>
  );
}

export function Dashboard() {
  const nav = useNavigate();
  const lang = useApp((s) => s.activeLanguage);
  const userFirstName = firstName(useAuth((s) => s.user));
  useDocumentTitle(`Hoje · ${BRAND.name}`);

  const { data, loading, error, reload } = useAsync(async () => {
    const index = await loadIndex();
    const entry = index.languages.find((l) => l.code === lang) ?? index.languages[0];
    if (!entry) throw new Error("Nenhum idioma disponível.");
    // O idioma ativo não existe mais no índice? Conserta o store em vez de só
    // cair no primeiro: o resto do app (badge de vencidos, /review, /progress)
    // continuaria no idioma antigo e a tela misturaria os dois.
    if (entry.code !== lang) useApp.getState().setActiveLanguage(entry.code);
    const course = await loadCourse(entry.coursePath);
    const [progress, overview, status, stats, overdue] = await Promise.all([
      getAllProgress(entry.code),
      getOverview(entry.code),
      loadLemmaStatus(entry.code),
      dailyStats(entry.code),
      mostOverdue(entry.code),
    ]);
    const next = nextDose(course, progress);
    // O método é uma dose por dia: a tela precisa saber se a de hoje já saiu.
    const today = dayKey();
    const doneTodayId = [...progress.values()].find(
      (p) => p.completed && p.completedAt && dayKey(new Date(p.completedAt)) === today,
    )?.doseId;
    const doneToday = doneTodayId ? (course.doses.find((d) => d.id === doneTodayId) ?? null) : null;
    const newReady = next ? await countNewReady(next.id, entry.code, next.cardCount) : 0;
    const learnAhead = await countLearnAhead(entry.code);
    // A dose de hoje entra inteira (são ~40 KB, servidos do disco) para a tela
    // poder mostrar a fala de abertura, as 20 palavras e a capa.
    const ref = next ?? doneToday;
    const nextDoseFull = ref ? await loadDose(entry.code, ref.path).catch(() => null) : null;
    const resumeMs = next ? await getMediaPosition(next.id) : 0;
    const week = Array.from({ length: 7 }, (_, i) => {
      const day = shiftDay(today, i - 6);
      const s = stats.get(day);
      return { day, active: !!s && dayIsActive(s) };
    });
    return {
      resumeMs, entry, course, progress, overview, next, doneToday, newReady, nextDoseFull, status, week, overdue,
      learnAhead,
    };
  }, [lang]);

  // Vivo no tempo: quando um card vence, o número muda sozinho (sem F5).
  const due = useDueCount(lang);

  if (loading) return <HomeSkeleton />;
  if (error || !data) return <ErrorScreen message={error?.message ?? "Erro"} onRetry={reload} />;

  const { entry, course, progress, overview, next, doneToday, newReady, nextDoseFull, resumeMs, status, week, overdue, learnAhead } = data;
  const doneIds = new Set(
    course.doses.filter((d) => progress.get(d.id)?.completed).map((d) => d.id),
  );
  const featured: DoseRef | null = next ?? doneToday;
  const featuredProgress = featured ? progress.get(featured.id) : undefined;
  const phasesDone = doneToday && featured?.id === doneToday.id
    ? ["prime", "immersion", "review"]
    : (featuredProgress?.phases ?? []);
  const inProgress = !!next && phasesDone.length > 0 && !doneToday;
  // Só oferece "continuar de X" se houver posição real salva no vídeo.
  const canResume = inProgress && resumeMs > 15_000;
  const opening = openingLine(nextDoseFull);
  const poster =
    featured && (nextDoseFull?.media.posterSrc ?? featured.posterSrc)
      ? mediaUrl(entry.code, featured.path, nextDoseFull?.media.posterSrc ?? featured.posterSrc!)
      : null;
  const share =
    nextDoseFull && hasTokens(nextDoseFull.segments)
      ? knownShare(coverage(nextDoseFull.segments, status))
      : null;
  const knownPct = share != null ? Math.round(share * 100) : null;
  const streak = overview.streak.current;
  const overdueWord = overdue ? lemmaOfCardId(overdue.cardId) : null;
  const overdueDays = overdue ? Math.max(1, Math.floor((Date.now() - overdue.due) / 86_400_000)) : 0;

  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div>
          <p className="text-xs text-faint">{todayLabel()}</p>
          <h1 className="font-display mt-1 text-[1.75rem] leading-tight md:text-[1.9rem]">
            {greeting()}{userFirstName ? `, ${userFirstName}` : ""}.
          </h1>
        </div>
        <WeekStrip days={week} streak={streak} doneToday={!!doneToday} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_236px]">
        {/* Coluna da dose */}
        <div className="flex min-w-0 flex-col gap-4">
          {featured ? (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <Card className="grid overflow-hidden md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] md:grid-rows-[auto_1fr]">
                {/* Coluna do vídeo: a capa inteira (16:9, sem corte) e, embaixo,
                    as 20 palavras que ele ensina. No celular a ordem é capa,
                    texto e botão, palavras — o botão não pode cair abaixo da dobra. */}
                {poster && (
                  <button
                    onClick={() => nav(`/dose/${featured.id}`)}
                    className="relative block aspect-video w-full overflow-hidden bg-surface-2 text-left md:col-start-1 md:row-start-1 md:border-r md:border-line"
                    aria-label="Abrir a dose"
                  >
                    <img src={poster} alt="" className="h-full w-full object-cover" />
                    <span className="timecode absolute bottom-2.5 left-2.5 rounded bg-black/70 px-1.5 py-0.5 text-white">
                      {fmtClock(featured.durationSec * 1000)}
                    </span>
                  </button>
                )}
                {nextDoseFull && nextDoseFull.cards.length > 0 && (
                  <div className="order-3 border-t border-line px-5 pb-5 pt-4 md:order-none md:col-start-1 md:row-start-2 md:border-r md:border-t-0">
                    <VocabStrip dose={nextDoseFull} status={status} />
                  </div>
                )}

                <div className="min-w-0 px-5 py-5 md:col-start-2 md:row-span-2 md:row-start-1 md:px-6">
                  <div className="flex items-baseline gap-2.5 text-xs">
                    <span className="font-semibold text-brand">{featured.level}</span>
                    <span className="text-muted">
                      {BRAND.unit} {featured.lessonNumber} de {course.doses.length}
                    </span>
                    {doneToday && (
                      <span className="ml-auto inline-flex items-center gap-1 font-semibold text-good">
                        <Check size={12} strokeWidth={3} /> concluída hoje
                      </span>
                    )}
                  </div>
                  <h2 className="font-display mt-1.5 text-[1.5rem] leading-tight md:text-[1.625rem]">
                    {featured.title}
                  </h2>
                  {nextDoseFull?.titleTarget && (
                    <p className="font-target mt-1 truncate text-[0.875rem] text-muted">
                      {nextDoseFull.titleTarget.split(" · ")[0]}
                      {nextDoseFull.source.creator ? ` · ${nextDoseFull.source.creator.split(" ")[0]}` : ""}
                    </p>
                  )}

                  {/* A primeira fala do vídeo. Ver a língua antes de decidir começar
                      é o que diferencia esta tela de um card genérico de curso. */}
                  {opening && (
                    <div className="mt-4 border-t border-line pt-4">
                      <DoseLine
                        size="lg"
                        startMs={opening.startMs}
                        target={opening.target}
                        translation={opening.translation}
                      />
                    </div>
                  )}

                  <Phases dose={nextDoseFull ?? featured} phases={phasesDone} />

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    {doneToday ? (
                      <>
                        <Button onClick={() => nav(`/dose/${featured.id}?fase=imersao`)}>
                          <RotateCcw size={15} /> Rever a imersão
                        </Button>
                        {next && (
                          <Button variant="ghost" onClick={() => nav(`/dose/${next.id}`)}>
                            Adiantar a próxima
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button size="lg" onClick={() => nav(`/dose/${featured.id}`)}>
                        <Play size={16} /> {inProgress ? "Continuar" : "Começar a dose"}
                      </Button>
                    )}
                    <span className="text-xs text-faint">
                      {canResume
                        ? `Retoma o vídeo em ${fmtClock(resumeMs)}`
                        : knownPct != null && knownPct > 0
                          ? `${knownPct}% desta lição você já entende`
                          : null}
                    </span>
                  </div>

                </div>
              </Card>
            </motion.div>
          ) : (
            <Card className="px-6 py-10 text-center">
              <Check size={20} className="mx-auto text-good" />
              <h2 className="font-display mt-3 text-xl">Trilha concluída</h2>
              <p className="mx-auto mt-1.5 max-w-[38ch] text-sm leading-relaxed text-muted">
                Você fez todas as doses disponíveis. Siga revisando os cards para consolidar.
              </p>
            </Card>
          )}

          <Trail
            lang={entry.code}
            doses={course.doses}
            doneIds={doneIds}
            currentId={next?.id}
            total={course.doses.length}
          />
        </div>

        {/* Coluna lateral: revisão e números, em letra pequena */}
        <div className="flex flex-col gap-4">
          <Card className="px-4 py-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold">Revisão</span>
              <span className="timecode text-faint">vira às 4:00</span>
            </div>
            <div className="mt-2.5 text-[1.75rem] font-semibold leading-none tabular-nums">
              {due}
              <span className="ml-1.5 text-[0.8125rem] font-normal text-muted">
                {pluralize(due, "card vencido", "cards vencidos")}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted">
              {due > 0
                ? `Uns ${Math.max(1, Math.round(due / 2))} ${pluralize(Math.max(1, Math.round(due / 2)), "minuto", "minutos")}.`
                : learnAhead > 0
                  ? `${learnAhead} em aprendizado ${learnAhead === 1 ? "volta" : "voltam"} em minutos — a revisão já os aceita.`
                  : "Os cards aparecem aqui sozinhos quando vencem."}
              {newReady > 0 &&
                ` ${newReady} ${pluralize(newReady, "palavra nova", "palavras novas")} na dose de hoje.`}
            </p>
            {(due > 0 || learnAhead > 0) && (
              <Button size="sm" variant={due > 0 ? "primary" : "secondary"} className="mt-3.5" onClick={() => nav("/review")}>
                Revisar agora
              </Button>
            )}
            {overdue && overdueWord && (
              <div className="mt-3.5 flex items-center gap-2.5 border-t border-line pt-3 text-xs text-muted">
                <span className="font-target-display text-lg leading-none text-fg">{overdueWord}</span>
                <span>o mais atrasado</span>
                <span className="timecode ml-auto text-faint">
                  {overdueDays} {pluralize(overdueDays, "dia", "dias")}
                </span>
              </div>
            )}
          </Card>

          <Card className="px-4 py-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold">Até aqui</span>
              <span className="timecode text-faint">{entry.nativeName}</span>
            </div>
            <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-2 text-[0.8125rem]">
              <dt className="text-muted">Palavras fixadas</dt>
              <dd className="text-right font-semibold tabular-nums">{overview.cardsKnown}</dd>
              <dt className="text-muted">Em aprendizado</dt>
              <dd className="text-right font-semibold tabular-nums">{overview.cardsLearning}</dd>
              <dt className="text-muted">Doses feitas</dt>
              <dd className="text-right font-semibold tabular-nums">{overview.dosesCompleted}</dd>
              <dt className="text-muted">Imersão</dt>
              <dd className="text-right font-semibold tabular-nums">
                {fmtDuration(overview.immersionMsTotal / 1000)}
              </dd>
              <dt className="text-muted">Revisões</dt>
              <dd className="text-right font-semibold tabular-nums">{overview.reviewsTotal}</dd>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
