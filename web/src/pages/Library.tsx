import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Headphones, Search, X } from "lucide-react";
import { loadIndex, loadCourse, mediaUrl } from "@/lib/content";
import { getAllProgress, nextDose } from "@/lib/progress";
import { useAsync, useDocumentTitle, useHotkeys, isTypingTarget } from "@/lib/hooks";
import { useApp } from "@/lib/store";
import { BRAND } from "@/lib/brand";
import { ListSkeleton, ErrorScreen, EmptyState } from "@/components/ui/feedback";
import { ProgressBar } from "@/components/ui/progress";
import { Segmented } from "@/components/ui/Segmented";
import { Kbd } from "@/components/ui/primitives";
import { fmtDuration, cn } from "@/lib/utils";
import type { DoseRef } from "@/types/dose";

type Status = "done" | "progress" | "todo";
type Filter = "all" | "todo" | "done";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Todas" },
  { value: "todo", label: "Pendentes" },
  { value: "done", label: "Concluídas" },
];

/** Normaliza para busca sem acento: "imersao" acha "Imersão". */
const norm = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function Library() {
  useDocumentTitle("Biblioteca · " + BRAND.name);
  const nav = useNavigate();
  const lang = useApp((s) => s.activeLanguage);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" foca a busca, Esc limpa — sem tirar a mão do teclado.
  useHotkeys((e) => {
    if (e.key === "/" && !isTypingTarget(e) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (e.key === "Escape" && document.activeElement === searchRef.current) {
      setQuery("");
      searchRef.current?.blur();
    }
  });

  const { data, loading, error, reload } = useAsync(async () => {
    const index = await loadIndex();
    const entry = index.languages.find((l) => l.code === lang) ?? index.languages[0];
    if (!entry) throw new Error("Nenhum idioma disponível.");
    // ver Dashboard: idioma ativo inexistente é corrigido no store, não mascarado
    if (entry.code !== lang) useApp.getState().setActiveLanguage(entry.code);
    const course = await loadCourse(entry.coursePath);
    const progress = await getAllProgress(entry.code);
    return { index, entry, course, progress };
  }, [lang]);

  const status = (d: DoseRef): Status => {
    const p = data?.progress.get(d.id);
    if (p?.completed) return "done";
    if (p && p.phases.length > 0) return "progress";
    return "todo";
  };

  const byLevel = useMemo(() => {
    if (!data) return [];
    const q = norm(query.trim());
    return data.course.levels
      .map((lv) => ({
        level: lv,
        doses: data.course.doses.filter((d) => {
          if (d.level !== lv.id) return false;
          const st = status(d);
          if (filter === "done" && st !== "done") return false;
          if (filter === "todo" && st === "done") return false;
          if (!q) return true;
          return (
            norm(d.title).includes(q) ||
            norm(d.level).includes(q) ||
            String(d.lessonNumber) === q
          );
        }),
      }))
      .filter((g) => g.doses.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, query, filter]);

  if (loading) return <ListSkeleton rows={7} />;
  if (error || !data) return <ErrorScreen message={error?.message ?? "Erro"} onRetry={reload} />;

  const { entry, course, progress } = data;
  const doneCount = course.doses.filter((d) => progress.get(d.id)?.completed).length;
  const nextId = nextDose(course, progress)?.id;
  const shown = byLevel.reduce((n, g) => n + g.doses.length, 0);
  const filtering = query.trim() !== "" || filter !== "all";
  const totalSec = course.doses.reduce((a, d) => a + d.durationSec, 0);
  const totalCards = course.doses.reduce((a, d) => a + d.cardCount, 0);

  return (
    <div className="mx-auto max-w-[960px]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="page-title">Biblioteca</h1>
          <p className="mt-1 text-sm text-muted">
            {course.name}, {course.doses.length} {pluralizeDose(course.doses.length)} em{" "}
            {course.doses.every((d) => d.mediaKind === "video") ? "vídeo" : "áudio e vídeo"}, {doneCount}{" "}
            {doneCount === 1 ? "concluída" : "concluídas"}
          </p>
        </div>
        <Segmented value={filter} onChange={setFilter} options={FILTERS} size="sm" />
      </header>

      <div className="mt-4">
        <ProgressBar value={doneCount} max={course.doses.length} />
      </div>

      {/* Busca + total do curso */}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-[22rem]">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por título ou nível"
            aria-label="Buscar doses"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-16 text-sm text-fg placeholder:text-faint focus:border-line-strong"
          />
          {query ? (
            <button
              onClick={() => setQuery("")}
              aria-label="Limpar busca"
              className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-faint transition-colors hover:text-fg"
            >
              <X size={13} />
            </button>
          ) : (
            <span className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 md:block">
              <Kbd>/</Kbd>
            </span>
          )}
        </div>
        <span className="timecode text-faint">
          {fmtDuration(totalSec)} de {course.doses.every((d) => d.mediaKind === "video") ? "vídeo" : "mídia"},{" "}
          {totalCards} palavras
        </span>
      </div>

      {filtering && (
        <p className="mt-2.5 text-xs text-faint">
          {shown} {shown === 1 ? "dose encontrada" : "doses encontradas"}
        </p>
      )}

      {byLevel.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="Nenhuma dose encontrada"
            description="Tente outro termo ou volte o filtro para “Todas”."
          />
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-10">
          {byLevel.map((g) => (
            <section key={g.level.id}>
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line pb-3">
                <h2 className="font-display text-[1.5rem] font-normal">{g.level.name}</h2>
                <span className="timecode text-faint">{g.level.id}</span>
                {!filtering && (
                  <p className="line-trans w-full text-[0.9375rem] text-muted sm:ml-auto sm:w-auto">
                    {g.level.description}
                  </p>
                )}
              </div>

              {/* Lâminas: a trilha é uma sequência de verdade (uma dose por dia,
                  i+1), então o número é posição. O estado está na imagem: feita
                  em cor com marca, próxima com contorno, futura em cinza. Sem
                  caixa em volta — é quadro com legenda, como num catálogo. */}
              <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4">
                {g.doses.map((d) => {
                  const st = status(d);
                  const isNext = d.id === nextId;
                  const poster = d.posterSrc ? mediaUrl(entry.code, d.path, d.posterSrc) : null;
                  const dim = st === "todo" && !isNext;
                  return (
                    <li key={d.id}>
                      <button
                        onClick={() => nav(`/dose/${d.id}`)}
                        className="group flex h-full w-full flex-col text-left"
                      >
                        <span
                          className={cn(
                            "relative block aspect-video w-full overflow-hidden rounded-lg border border-line bg-surface-2 transition-colors group-hover:border-line-strong",
                            isNext && "outline outline-2 -outline-offset-2 outline-brand",
                          )}
                        >
                          {poster && (
                            <img
                              src={poster}
                              alt=""
                              loading="lazy"
                              className={cn(
                                "h-full w-full object-cover transition-[filter,opacity]",
                                dim && "opacity-50 grayscale group-hover:opacity-80 group-hover:grayscale-0",
                              )}
                            />
                          )}
                          <span className="timecode absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[0.6875rem] text-white">
                            {String(d.lessonNumber).padStart(2, "0")}
                          </span>
                          <span className="timecode absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[0.6875rem] text-white">
                            {fmtDuration(d.durationSec)}
                          </span>
                          {st === "done" && (
                            <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-brand text-brand-fg">
                              <Check size={11} strokeWidth={3.5} />
                            </span>
                          )}
                        </span>
                        <span
                          className={cn(
                            "mt-2.5 text-[0.875rem] font-medium leading-snug",
                            dim ? "text-muted" : "text-fg",
                          )}
                        >
                          {d.title}
                        </span>
                        {/* Só quem tem estado ganha a linha: a futura fica só com
                            o título (o "20 palavras" repetido em cada uma era ruído). */}
                        {st === "done" ? (
                          <span className="mt-1 text-[0.6875rem] font-semibold text-good">feita</span>
                        ) : isNext || st === "progress" ? (
                          <span className="mt-1 text-[0.6875rem] font-semibold text-brand">
                            {st === "progress" ? "em andamento" : "próxima"}
                          </span>
                        ) : null}
                      </button>
                      {st === "done" && d.condensedAudioSrc && (
                        <button
                          onClick={() => nav(`/escuta/${d.id}`)}
                          className="mt-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-muted transition-colors hover:text-brand"
                          title="Reouvir só as falas, sem o vídeo (funciona offline)"
                        >
                          <Headphones size={11} /> ouvir condensado
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function pluralizeDose(n: number) {
  return n === 1 ? BRAND.unit.toLowerCase() : `${BRAND.unit.toLowerCase()}s`;
}
