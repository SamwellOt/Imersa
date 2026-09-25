import { db, dailyStats } from "@/lib/db";
import { getOverview, dayIsActive } from "@/lib/progress";
import { getLevelProgress, daysToFinish, type LevelProgress } from "@/lib/levels";
import { getSrsSettings, unsuspendAll, unmarkKnown } from "@/lib/srs";
import { marksByDose } from "@/lib/marks";
import type { CardRecord } from "@/lib/db";
import { computeSrsStats, type SrsStats } from "@/lib/srsStats";
import { loadCourseByLanguage, loadDose, mediaUrl } from "@/lib/content";
import { getAllProgress } from "@/lib/progress";
import { loadLemmaStatus, coverage, knownShare, type Coverage } from "@/lib/vocab";
import { useAsync, useDocumentTitle } from "@/lib/hooks";
import { useApp } from "@/lib/store";
import { BRAND } from "@/lib/brand";
import { SectionLabel } from "@/components/ui/primitives";
import { StatsSkeleton, ErrorScreen } from "@/components/ui/feedback";
import { dayKey, shiftDay, fmtDuration, pluralize, cn } from "@/lib/utils";
import { humanDays } from "@/lib/srs";
import { useState, type ReactNode } from "react";
import { Undo2 } from "lucide-react";

const DAYS = 28;

const pct = (n: number, total: number) =>
  n <= 0 || total <= 0 ? "0%" : `${Math.min(100, Math.max(0.8, (n / total) * 100))}%`;

/**
 * Onde o aluno está na escada de vocabulário do idioma (TOPIK, no coreano).
 * A barra mostra duas camadas: o que já está fixado e, mais fraco, o que ainda
 * está em aprendizado — misturar os dois num número só inflaria o progresso.
 */
function LevelLadder({ level, newPerDay }: { level: LevelProgress; newPerDay: number }) {
  const cur = level.current;
  const dias = daysToFinish(cur, newPerDay);
  const faltaConteudo = cur.available < cur.words;
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-display text-[1.375rem]">{cur.name}</span>
        <span className="text-sm tabular-nums text-muted">
          <span className="font-semibold text-fg">{cur.known}</span> de{" "}
          {cur.words.toLocaleString("pt-BR")} palavras
        </span>
      </div>

      {/* nas primeiras semanas a fração é minúscula (8 de 1.866): um mínimo
          visível evita a barra parecer quebrada em vez de "começando". */}
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-3">
        <div className="bg-brand" style={{ width: pct(cur.known, cur.words) }} />
        <div className="bg-brand/30" style={{ width: pct(cur.learning, cur.words) }} />
      </div>
      <p className="mt-2 text-xs text-faint">
        {cur.learning > 0 && <>{cur.learning} em aprendizado. </>}
        {dias === 0
          ? "Você já cobriu tudo o que o curso tem nesta faixa."
          : dias != null && (
              <>
                Uns {dias} {dias === 1 ? "dia" : "dias"} no seu ritmo de {newPerDay} palavras por dia
                {faltaConteudo && <>, até o fim do conteúdo publicado</>}.
              </>
            )}
      </p>

      <div className="mt-4 border-t border-line">
        {level.tiers.map((t) => {
          const here = t.tier === cur.tier;
          return (
            <div
              key={t.tier}
              className="flex items-baseline gap-2.5 border-b border-line py-2 text-sm"
              aria-current={here ? "step" : undefined}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full",
                  here ? "bg-brand" : "bg-line-strong",
                )}
                aria-hidden
              />
              <span className={cn("min-w-0 flex-1", here ? "text-fg" : "text-faint")}>
                {t.name} <span className="text-faint">· {t.exam} · {t.cefr}</span>
              </span>
              <span className="tabular-nums text-faint">
                {t.known}/{t.words.toLocaleString("pt-BR")}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[0.6875rem] leading-relaxed text-faint">
        Contagem sobre {level.source}. Uma palavra entra quando o FSRS a considera fixada.
      </p>
    </div>
  );
}

/** Uma lição na lista de compreensão. */
interface LessonRow {
  id: string;
  lessonNumber: number;
  title: string;
  cov: Coverage;
  completed: boolean;
  next: boolean;
  immersionMs: number;
  poster: string | null;
  /** Falas marcadas «não entendi» e total de falas: a compreensão REAL. */
  unclear: number;
  segments: number;
}

/**
 * Compreensão por lição: que fração do que É DITO em cada lição o aluno já tem
 * fixado (por ocorrência, não por palavra distinta — é a medida de "entendo
 * isso ao ouvir"). A lição seguinte mostra o i+1 em número: quanto dela já vem
 * sabido antes de começar. Lição de build antigo (sem tokens) fica de fora.
 */
async function lessonRows(lang: string, course: Awaited<ReturnType<typeof loadCourseByLanguage>>): Promise<LessonRow[]> {
  const [status, progress, imm, marks] = await Promise.all([
    loadLemmaStatus(lang),
    getAllProgress(lang),
    db.immersionLog.where("language").equals(lang).toArray(),
    marksByDose(lang),
  ]);
  const msByDose = new Map<string, number>();
  for (const i of imm) if (i.doseId) msByDose.set(i.doseId, (msByDose.get(i.doseId) ?? 0) + i.ms);
  const doses = await Promise.all(
    course.doses.map((ref) => loadDose(lang, ref.path).catch(() => null)),
  );
  let nextFound = false;
  const rows: LessonRow[] = [];
  for (const [k, ref] of course.doses.entries()) {
    const dose = doses[k];
    if (!dose) continue;
    const cov = coverage(dose.segments, status);
    if (!cov.tokens) continue;
    const completed = progress.get(ref.id)?.completed ?? false;
    const next = !completed && !nextFound;
    if (next) nextFound = true;
    const posterRel = dose.media.posterSrc ?? ref.posterSrc ?? null;
    rows.push({
      id: ref.id, lessonNumber: ref.lessonNumber, title: ref.title, cov, completed, next,
      immersionMs: msByDose.get(ref.id) ?? 0,
      poster: posterRel ? mediaUrl(lang, ref.path, posterRel) : null,
      unclear: new Set((marks.get(ref.id) ?? []).map((m) => m.segmentId)).size,
      segments: dose.segments.length,
    });
  }
  return rows;
}

function LessonCoverage({ rows }: { rows: LessonRow[] }) {
  return (
    <div className="mt-3">
      {rows.map((r) => {
        const share = knownShare(r.cov) ?? 0;
        const learn = r.cov.tokens ? r.cov.learning / r.cov.tokens : 0;
        const left = r.cov.lemmas - r.cov.lemmasKnown - r.cov.lemmasLearning;
        const dim = !r.completed && !r.next;
        return (
          <div
            key={r.id}
            className="grid grid-cols-[3.75rem_minmax(0,1fr)_2.75rem] items-center gap-3 border-b border-line py-2.5"
            aria-current={r.next ? "step" : undefined}
          >
            {/* lição futura em cinza: o percentual dela é informação de i+1, não fracasso */}
            {r.poster ? (
              <img
                src={r.poster}
                alt=""
                loading="lazy"
                className={cn("aspect-video w-full rounded border border-line object-cover", dim && "opacity-45 grayscale")}
              />
            ) : (
              <span className="timecode text-center text-faint">{String(r.lessonNumber).padStart(2, "0")}</span>
            )}
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="timecode text-faint">{String(r.lessonNumber).padStart(2, "0")}</span>
                <span className={cn("min-w-0 truncate", dim ? "text-muted" : "text-fg")}>{r.title}</span>
                {r.next && <span className="shrink-0 text-[0.6875rem] font-semibold text-brand">próxima, i+1</span>}
              </div>
              <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-surface-3">
                <div className="bg-brand" style={{ width: `${share * 100}%` }} />
                <div className="bg-brand/30" style={{ width: `${learn * 100}%` }} />
              </div>
              <p className="mt-1 text-[0.6875rem] tabular-nums text-faint">
                {r.cov.lemmas} {pluralize(r.cov.lemmas, "palavra", "palavras")}, {r.cov.lemmasKnown} conhecidas
                {r.cov.lemmasLearning > 0 && <>, {r.cov.lemmasLearning} aprendendo</>}
                {left > 0 && <>, {left} por estudar</>}
                {r.immersionMs >= 60_000 && <>. {fmtDuration(r.immersionMs / 1000)} de imersão</>}
                {r.unclear > 0 && (
                  <>. <span className="text-hard">{r.unclear} {pluralize(r.unclear, "fala não entendida", "falas não entendidas")}</span>{" "}
                  ({Math.round((1 - r.unclear / r.segments) * 100)}% entendidas)</>
                )}
              </p>
            </div>
            <span className={cn("text-right text-sm tabular-nums", dim ? "text-faint" : "font-semibold")}>
              {Math.round(share * 100)}%
            </span>
          </div>
        );
      })}
      <p className="pt-3 text-[0.6875rem] leading-relaxed text-faint">
        Porcentagem do que é dito na lição (cada ocorrência de palavra de conteúdo) que você
        já conhece: a base do curso somada ao que o FSRS já considera fixado. A faixa clara é
        o que está em aprendizado. Na próxima lição, é o quanto já vem sabido antes de começar.
        As falas «não entendidas» (tecla N no player) são a compreensão real, para comparar com
        a prevista.
      </p>
    </div>
  );
}

/** «Já sei»: a lista, com o caminho de volta (a palavra torna a ser nova). */
function KnownWords({ recs, onChange }: { recs: CardRecord[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const shown = open ? recs : recs.slice(0, 24);
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((r) => (
          <button
            key={r.key}
            onClick={async () => {
              await unmarkKnown(r);
              onChange();
            }}
            title="Voltar a estudar esta palavra"
            className="group inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-sm transition-colors hover:border-line-strong"
          >
            <span className="font-target">{r.cardId.replace(/^w-/, "")}</span>
            <Undo2 size={11} className="text-faint opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>
      {recs.length > shown.length && (
        <button onClick={() => setOpen(true)} className="mt-2 text-xs text-muted hover:text-fg">
          mostrar as {recs.length}
        </button>
      )}
      <p className="pt-3 text-[0.6875rem] leading-relaxed text-faint">
        Contam como conhecidas e ficam fora das revisões. Toque numa palavra para voltar a
        estudá-la. Em Ajustes → Dados dá para exportar a lista para a fábrica de lições.
      </p>
    </div>
  );
}

function Metric({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <div>
      <div className="text-[1.5rem] font-semibold leading-none tabular-nums">{value}</div>
      <div className="mt-1.5 text-xs text-muted">{label}</div>
      {hint && <div className="mt-0.5 text-[0.6875rem] text-faint">{hint}</div>}
    </div>
  );
}

export function Progress() {
  useDocumentTitle("Progresso · " + BRAND.name);
  const lang = useApp((s) => s.activeLanguage);

  const { data, loading, error, reload } = useAsync(async () => {
    if (!lang) throw new Error("Sem idioma ativo.");
    const course = await loadCourseByLanguage(lang);
    const [overview, statMap, cards, level, srs, lessons] = await Promise.all([
      getOverview(lang),
      dailyStats(lang),
      db.cards.where("language").equals(lang).toArray(),
      getLevelProgress(lang, course),
      getSrsSettings(),
      lessonRows(lang, course),
    ]);
    // Aritmética de calendário (`shiftDay`), não `- 86_400_000`: num fuso com
    // horário de verão o passo de 24 h fixas repete ou pula um dia da série.
    const today = dayKey();
    const series = Array.from({ length: DAYS }, (_, i) => {
      const d = shiftDay(today, i - (DAYS - 1));
      const [y, m, dd] = d.split("-").map(Number);
      const s = statMap.get(d);
      return {
        day: d,
        date: new Date(y, m - 1, dd),
        reviews: s?.reviews ?? 0,
        immersionMs: s?.immersionMs ?? 0,
      };
    });
    const stats = await computeSrsStats(lang, srs);
    // "Novos" aqui = cards reiniciados (o registro só nasce na primeira nota).
    const st = stats.states;
    const states = { learning: st.learning + st.new, review: st.review, relearning: st.relearning };
    const known = cards.filter((c) => c.known && c.cardId.startsWith("w-"))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      overview, series, states, totalCards: cards.length, level, stats, lessons, known,
      newPerDay: srs.newPerDay, targetRetention: srs.requestRetention,
    };
  }, [lang]);

  const reactivate = async () => {
    if (!lang) return;
    await unsuspendAll(lang);
    reload();
  };

  if (loading) return <StatsSkeleton />;
  if (error || !data) return <ErrorScreen message={error?.message ?? "Erro"} onRetry={reload} />;

  const { overview, series, states, totalCards, level, newPerDay, stats, targetRetention, lessons, known } = data;
  const active = Math.max(1, totalCards - stats.states.suspended);
  const maxRev = Math.max(1, ...series.map((s) => s.reviews));
  const activeDays = series.filter((s) => dayIsActive({ ...s, dosesCompleted: 0 })).length;
  const hasActivity = overview.reviewsTotal > 0 || overview.immersionMsTotal > 0;
  const fmtDay = (d: Date) =>
    new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(d).replace(".", "");
  const streak = overview.streak.current;

  return (
    <div className="mx-auto max-w-[960px]">
      <h1 className="page-title">Progresso</h1>

      {/* Os números, numa frase — não numa grade de tiles. Quando é tudo zero,
          a frase diz que ainda não começou e a página não parece quebrada. */}
      <p className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 text-[0.9375rem] text-muted">
        {hasActivity ? (
          <>
            <Num n={streak} label={pluralize(streak, "dia seguido", "dias seguidos")} />
            <Sep />
            <Num n={overview.cardsKnown} label="palavras fixadas" />
            <Sep />
            <Num n={overview.dosesCompleted} label={pluralize(overview.dosesCompleted, "dose", "doses")} />
            <Sep />
            <Num n={fmtDuration(overview.immersionMsTotal / 1000)} label="de imersão" />
            <Sep />
            <Num n={overview.reviewsTotal} label={pluralize(overview.reviewsTotal, "revisão", "revisões")} />
            {overview.streak.longest > streak && (
              <>
                <Sep />
                <span>melhor sequência {overview.streak.longest}</span>
              </>
            )}
          </>
        ) : (
          <span>Ainda sem estudo. Faça a primeira dose para acompanhar sua evolução aqui.</span>
        )}
      </p>

      <div className="mt-8 grid gap-10 lg:grid-cols-2 lg:gap-x-10">
        <div className="flex flex-col gap-10">
          {/* Atividade: um quadrado por dia, não barras — o que importa é
              "estudei ou não estudei", e a intensidade dá o volume. */}
          <section>
            <SectionLabel>Últimos {DAYS} dias</SectionLabel>
            <div className="mt-3 grid grid-cols-14 gap-1">
              {series.map((s, i) => {
                const share = s.reviews / maxRev;
                const studied = dayIsActive({ ...s, dosesCompleted: 0 });
                const tone = !studied
                  ? "bg-surface-3"
                  : share > 0.66
                    ? "bg-brand"
                    : share > 0.33
                      ? "bg-brand/60"
                      : "bg-brand/30";
                return (
                  <div
                    key={s.day}
                    className={cn(
                      "aspect-square rounded-[3px]",
                      tone,
                      i === series.length - 1 && "outline outline-1 -outline-offset-1 outline-line-strong",
                    )}
                    title={`${fmtDay(s.date)}: ${s.reviews} ${pluralize(s.reviews, "revisão", "revisões")}${s.immersionMs >= 60_000 ? `, ${fmtDuration(s.immersionMs / 1000)} de imersão` : ""}`}
                  />
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between text-[0.6875rem] text-faint">
              <span>{fmtDay(series[0].date)}</span>
              <span className="tabular-nums">
                {activeDays} {pluralize(activeDays, "dia com estudo", "dias com estudo")}
                {maxRev > 1 && `, pico de ${maxRev} revisões`}
              </span>
              <span>hoje</span>
            </div>
          </section>

          {lessons.length > 0 && (
            <section>
              <SectionLabel>Compreensão por lição</SectionLabel>
              <LessonCoverage rows={lessons} />
            </section>
          )}

          {known.length > 0 && (
            <section>
              <SectionLabel>Palavras que você já sabia, {known.length}</SectionLabel>
              <KnownWords recs={known} onChange={reload} />
            </section>
          )}
        </div>

        <div className="flex flex-col gap-10">
          {level && (
            <section>
              <SectionLabel>Nível, vocabulário {level.exam}</SectionLabel>
              <LevelLadder level={level} newPerDay={newPerDay} />
            </section>
          )}

          {hasActivity && (
            <>
              {/* Retenção — o "True retention" do Anki. Retenção real = acertos em
                  cards que já estavam em revisão; é o número que o FSRS tenta levar
                  à retenção alvo. Estimada = média da probabilidade de lembrar agora. */}
              <section>
                <SectionLabel>Retenção</SectionLabel>
                <div className="mt-4 grid grid-cols-3 gap-4">
                  <Metric
                    value={fmtRate(stats.trueRetention.month.rate)}
                    label="real, 30 dias"
                    hint={sample(stats.trueRetention.month.total)}
                  />
                  <Metric
                    value={fmtRate(stats.avgRetrievability)}
                    label="estimada agora"
                    hint={stats.states.review ? `${stats.states.review} fixados` : "—"}
                  />
                  <Metric value={`${Math.round(targetRetention * 100)}%`} label="alvo do FSRS" hint="Ajustes" />
                </div>
                {/* Previsão de vencimentos: hoje (com atrasados) + 6 dias. */}
                <div className="mt-5 flex items-baseline justify-between text-xs">
                  <span className="text-muted">Vencimentos nos próximos 7 dias</span>
                  {stats.overdue > 0 && (
                    <span className="tabular-nums text-faint">{stats.overdue} {pluralize(stats.overdue, "atrasado", "atrasados")}</span>
                  )}
                </div>
                <Forecast days={stats.forecast} />
                <div className="mt-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-line pt-3 text-[0.75rem] text-faint tabular-nums">
                  <span className="text-muted">Botões, 30 dias</span>
                  <ButtonShare label="De novo" n={stats.buttons.again} total={stats.buttons.total} cls="text-again" />
                  <ButtonShare label="Difícil" n={stats.buttons.hard} total={stats.buttons.total} cls="text-hard" />
                  <ButtonShare label="Bom" n={stats.buttons.good} total={stats.buttons.total} cls="text-good" />
                  <ButtonShare label="Fácil" n={stats.buttons.easy} total={stats.buttons.total} cls="text-easy" />
                </div>
                <div className="mt-1.5 text-[0.75rem] text-faint tabular-nums">
                  Retenção real: hoje {fmtRate(stats.trueRetention.today.rate)}, 7 dias {fmtRate(stats.trueRetention.week.rate)}, total {fmtRate(stats.trueRetention.all.rate)}
                  {" "}({sample(stats.trueRetention.all.total)})
                </div>
              </section>

              {/* Distribuição dos cards */}
              <section>
                <SectionLabel>Seus cards, {totalCards}</SectionLabel>
                <div className="mt-4 flex h-2 gap-0.5 overflow-hidden rounded-full">
                  {states.review > 0 && (
                    <div className="bg-good" style={{ width: `${(states.review / active) * 100}%` }} />
                  )}
                  {states.learning > 0 && (
                    <div className="bg-hard" style={{ width: `${(states.learning / active) * 100}%` }} />
                  )}
                  {states.relearning > 0 && (
                    <div className="bg-again" style={{ width: `${(states.relearning / active) * 100}%` }} />
                  )}
                </div>
                <div className="mt-3.5 flex flex-wrap gap-x-6 gap-y-2">
                  <Legend color="bg-good" label="Fixados" n={states.review} />
                  <Legend color="bg-hard" label="Aprendendo" n={states.learning} />
                  <Legend color="bg-again" label="Reaprendendo" n={states.relearning} />
                </div>
                {(stats.avgIntervalDays != null || stats.states.suspended > 0 || stats.states.buried > 0) && (
                  <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line pt-3 text-[0.75rem] text-faint">
                    <span className="tabular-nums">
                      {stats.avgIntervalDays != null &&
                        `intervalo médio ${humanDays(stats.avgIntervalDays)}, estabilidade média ${humanDays(stats.avgStabilityDays ?? 0)}`}
                      {stats.states.buried > 0 &&
                        `, ${stats.states.buried} ${pluralize(stats.states.buried, "adiado", "adiados")}`}
                    </span>
                    {stats.states.suspended > 0 && (
                      <button onClick={reactivate} className="text-muted underline-offset-4 hover:text-fg hover:underline">
                        {stats.states.suspended} {pluralize(stats.states.suspended, "suspenso", "suspensos")}, reativar
                      </button>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Num({ n, label }: { n: ReactNode; label: string }) {
  return (
    <span>
      <b className="font-semibold text-fg tabular-nums">{n}</b> {label}
    </span>
  );
}

function Sep() {
  return <span className="text-line-strong" aria-hidden>·</span>;
}

function Legend({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} />
      <span className="text-muted">{label}</span>
      <span className="font-semibold tabular-nums">{n}</span>
    </div>
  );
}

function fmtRate(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function sample(n: number): string {
  return n ? `${n} ${pluralize(n, "revisão", "revisões")}` : "sem amostra";
}

function ButtonShare({ label, n, total, cls }: { label: string; n: number; total: number; cls: string }) {
  return (
    <span>
      <span className={cls}>{label}</span> {total ? `${Math.round((n / total) * 100)}%` : "—"}
    </span>
  );
}

/** Sete colunas, uma por dia — mesma linguagem do quadro de atividade. */
function Forecast({ days }: { days: SrsStats["forecast"] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  const labels = ["hoje", "amanhã"];
  const wd = (day: string) => {
    const [y, m, dd] = day.split("-").map(Number);
    return new Intl.DateTimeFormat("pt-BR", { weekday: "short" })
      .format(new Date(y, m - 1, dd))
      .replace(".", "");
  };
  // Barras sobre uma linha de base, sem trilho preenchido atrás — o trilho
  // fazia sete caixas iguais, e a leitura era "grade", não "quantidade".
  return (
    <div className="mt-3">
      <div className="grid grid-cols-7 gap-2 border-b border-line">
        {days.map((d, i) => (
          <div key={d.day} className="flex flex-col items-center">
            <span className="text-[0.6875rem] font-semibold tabular-nums text-muted">{d.count || ""}</span>
            <div className="mt-1 flex h-12 w-full items-end">
              <div
                className={cn("w-full rounded-t-[2px]", i === 0 ? "bg-brand" : "bg-brand/55")}
                style={{ height: d.count ? `${Math.max(4, (d.count / max) * 100)}%` : 0 }}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-7 gap-2 text-center text-[0.625rem] text-faint">
        {days.map((d, i) => (
          <span key={d.day}>{labels[i] ?? wd(d.day)}</span>
        ))}
      </div>
    </div>
  );
}
