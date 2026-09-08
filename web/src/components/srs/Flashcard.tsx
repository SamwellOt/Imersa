import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Volume2, Play, MoreHorizontal, CalendarClock, PauseCircle, RotateCcw } from "lucide-react";
import type { SentenceCard } from "@/types/dose";
import type { CardRecord } from "@/lib/db";
import {
  cardInfo, getSrsSettings, humanDays, previewIntervals, previewNewIntervals, RATINGS,
  type IntervalPreview, type ReviewRating, type SrsSettings,
} from "@/lib/srs";
import { Rating, State } from "ts-fsrs";
import { playRange, playFile, stop } from "@/lib/audioEngine";
import { useApp } from "@/lib/store";
import { useHotkeys, isInteractiveTarget } from "@/lib/hooks";
import { cn, fmtClock } from "@/lib/utils";
import { Kbd } from "@/components/ui/primitives";

/** Ações do Anki sobre o card em tela: adiar (bury), suspender, reiniciar (forget). */
export type CardAction = "bury" | "suspend" | "forget";

/**
 * A frase-exemplo (alvo + PT) com a palavra destacada, ao lado da cena do vídeo
 * de onde ela saiu: liga a palavra ao momento em que foi ouvida.
 */
function ExampleLine({ context, surface, scene }: { context: string; surface?: string; scene?: string }) {
  const sep = context.indexOf(" — ");
  const sentence = sep >= 0 ? context.slice(0, sep) : context;
  const pt = sep >= 0 ? context.slice(sep + 3) : "";
  const i = surface ? sentence.indexOf(surface) : -1;
  const text = (
    <>
      <p className="line-target text-[1.125rem] text-fg md:text-[1.1875rem]">
        {i >= 0 && surface ? (
          <>
            {sentence.slice(0, i)}
            <b className="border-b-2 border-brand/35 font-medium text-brand">{surface}</b>
            {sentence.slice(i + surface.length)}
          </>
        ) : (
          sentence
        )}
      </p>
      {pt && <p className="line-trans mt-0.5 text-[1rem] text-muted">{pt}</p>}
    </>
  );
  if (!scene) return <div className="text-center">{text}</div>;
  return (
    <div className="grid items-center gap-4 text-left sm:grid-cols-[8rem_minmax(0,1fr)]">
      <img src={scene} alt="" className="aspect-video w-full rounded-md border border-line object-cover" />
      <div className="min-w-0">{text}</div>
    </div>
  );
}

const GRADE_META: Record<ReviewRating, { label: string; key: string; color: string; bar: string; hover: string }> = {
  [Rating.Again]: { label: "De novo", key: "1", color: "text-again", bar: "bg-again", hover: "hover:bg-again/[0.07]" },
  [Rating.Hard]: { label: "Difícil", key: "2", color: "text-hard", bar: "bg-hard", hover: "hover:bg-hard/[0.07]" },
  [Rating.Good]: { label: "Bom", key: "3", color: "text-good", bar: "bg-good", hover: "hover:bg-good/[0.07]" },
  [Rating.Easy]: { label: "Fácil", key: "4", color: "text-easy", bar: "bg-easy", hover: "hover:bg-easy/[0.07]" },
};

/** Rótulo do estado, como o Anki colore os contadores (novo / aprendendo / revisão). */
function stateLabel(rec: CardRecord | undefined, isNew: boolean): { text: string; cls: string } {
  if (isNew || !rec || rec.state === State.New) return { text: "Palavra nova", cls: "text-accent" };
  if (rec.state === State.Learning) return { text: "Aprendendo", cls: "text-muted" };
  if (rec.state === State.Relearning) return { text: "Reaprendendo", cls: "text-muted" };
  return { text: "Revisão", cls: "text-muted" };
}

const ACTIONS: { id: CardAction; label: string; hint: string; key?: string; icon: typeof CalendarClock }[] = [
  { id: "bury", label: "Adiar para amanhã", hint: "Some das filas até o próximo dia", key: "-", icon: CalendarClock },
  { id: "suspend", label: "Suspender", hint: "Fica fora até reativar em Progresso", key: "@", icon: PauseCircle },
  { id: "forget", label: "Reiniciar card", hint: "Volta a novo, sem memória de intervalo", icon: RotateCcw },
];

export function Flashcard({
  rec,
  card,
  mediaUrl,
  wordAudioUrl,
  fragmentUrl,
  sceneUrl,
  isNew,
  settings,
  onGrade,
  onAction,
}: {
  rec?: CardRecord; // present only for already-seen (review) cards
  card: SentenceCard;
  mediaUrl: string; // main dose media (fallback for the fragment)
  wordAudioUrl?: string; // word TTS → front
  fragmentUrl?: string; // pre-cut example fragment → back
  sceneUrl?: string; // quadro do vídeo na frase-exemplo → back
  isNew: boolean;
  settings?: SrsSettings;
  onGrade: (rating: ReviewRating, elapsedMs: number) => void;
  /** Presente só para cards já vistos (novo sem registro não tem o que adiar). */
  onAction?: (action: CardAction) => void;
}) {
  const { furigana } = useApp();
  const [revealed, setReveal] = useState(false);
  const [intervals, setIntervals] = useState<Record<ReviewRating, IntervalPreview> | null>(null);
  const [menu, setMenu] = useState(false);
  const [srs, setSrs] = useState<SrsSettings | null>(settings ?? null);
  const shownAt = useRef(Date.now());
  // O menu ⋯ fecha ao clicar fora dele (antes só o botão e Esc fechavam, e ele
  // ficava aberto por cima do verso ao revelar a resposta).
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);
  // Uma nota por card. Dois toques rápidos (ou a tecla repetida) chegavam aqui
  // duas vezes antes de a fila avançar: o mesmo card era avaliado duas vezes, o
  // seguinte era pulado e a cota do dia perdia uma palavra à toa.
  const gradedRef = useRef(false);

  // Front: the word spoken by a native TTS. Back: the pre-cut immersion fragment.
  const playWord = () => {
    if (wordAudioUrl) playFile(wordAudioUrl);
    else playRange(mediaUrl, card.startMs, card.endMs); // fallback if no TTS
  };
  const playFragment = () => {
    if (fragmentUrl) playFile(fragmentUrl);
    else playRange(mediaUrl, card.startMs, card.endMs); // fallback: seek main media
  };

  // Um único timer de áudio por card: avaliar antes de ele disparar não pode
  // deixar o som do card anterior tocar por cima do próximo.
  const audioTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playSoon = (fn: () => void, delay: number) => {
    if (audioTimer.current) clearTimeout(audioTimer.current);
    audioTimer.current = setTimeout(fn, delay);
  };

  // On mount: reset, play the word, and load interval previews.
  useEffect(() => {
    setReveal(false);
    setMenu(false);
    shownAt.current = Date.now();
    playSoon(playWord, 180);
    (async () => {
      const s = settings ?? (await getSrsSettings());
      setSrs(s);
      setIntervals(await (rec ? previewIntervals(rec, s) : previewNewIntervals(s)));
    })();
    return () => {
      if (audioTimer.current) clearTimeout(audioTimer.current);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  const reveal = () => {
    setReveal(true);
    stop();
    playSoon(playFragment, 140); // hear the word in its real immersion sentence
  };
  const grade = (r: ReviewRating) => {
    if (gradedRef.current) return;
    gradedRef.current = true;
    if (audioTimer.current) clearTimeout(audioTimer.current);
    stop();
    onGrade(r, Date.now() - shownAt.current);
  };
  const act = (a: CardAction) => {
    if (!onAction || gradedRef.current) return;
    gradedRef.current = true; // o card sai da fila: nada mais pode acontecer com ele
    if (audioTimer.current) clearTimeout(audioTimer.current);
    stop();
    setMenu(false);
    onAction(a);
  };

  useHotkeys((e) => {
    if (e.repeat) return;
    // Foco num botão? Deixa o botão responder (senão Espaço faz as duas coisas).
    if (isInteractiveTarget(e)) return;
    if (e.key === "Escape" && menu) {
      setMenu(false);
      return;
    }
    if (e.code === "Space") {
      e.preventDefault();
      if (!revealed) reveal();
      return;
    }
    if (e.key.toLowerCase() === "j" || e.key === "0") {
      e.preventDefault();
      if (revealed) playFragment();
      else playWord();
      return;
    }
    // Atalhos do Anki: "-" adia, "@" suspende.
    if (onAction && e.key === "-") return act("bury");
    if (onAction && e.key === "@") return act("suspend");
    if (revealed && ["1", "2", "3", "4"].includes(e.key)) {
      grade(RATINGS[Number(e.key) - 1]);
    }
  });

  const label = stateLabel(rec, isNew);
  const info = rec && srs && rec.state !== State.New ? cardInfo(rec, srs) : null;

  return (
    <div className="flex w-full max-w-xl flex-col items-center">
      <div className="elev-2 w-full overflow-visible rounded-2xl border border-line bg-surface px-5 pb-6 pt-4 md:px-7">
        {/* Cabeçalho sem faixa: estado, rank e menu numa linha só */}
        <div className="flex items-center justify-between gap-3">
          <span className={cn("label-eyebrow", label.cls)}>{label.text}</span>
          <div className="flex items-center gap-2.5">
            {/* O rank é informação do VERSO: entregá-lo antes da resposta é uma
                pista grátis (palavra #1 é obviamente das mais comuns). Aparece só
                depois de revelar. O slot fica reservado, então nada salta. */}
            {card.freqRank ? (
              <span
                className={cn(
                  "timecode text-faint transition-opacity duration-200",
                  revealed ? "opacity-100" : "opacity-0",
                )}
                aria-hidden={!revealed}
                title="Posição na lista de frequência do idioma"
              >
                #{card.freqRank} em frequência
              </span>
            ) : null}
            {onAction && (
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenu((m) => !m)}
                  className={cn(
                    "grid h-7 w-7 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg",
                    menu && "bg-surface-2 text-fg",
                  )}
                  aria-label="Mais ações e informações do card"
                  aria-expanded={menu}
                >
                  <MoreHorizontal size={15} />
                </button>
                {menu && (
                  <div className="elev-2 absolute right-0 top-9 z-20 w-72 overflow-hidden rounded-xl border border-line bg-surface py-1">
                    {/* O "Card info" do Anki: o que a memória deste card tem hoje.
                        Mora aqui, não no verso — o verso é palavra, sentido, frase. */}
                    {info && (
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-b border-line px-3.5 py-2.5 text-[0.75rem] tabular-nums">
                        {rec!.state === State.Review && (
                          <>
                            <Info k="Retenção agora" v={`${Math.round(info.retrievability * 100)}%`} />
                            <Info k="Intervalo" v={humanDays(info.intervalDays)} />
                          </>
                        )}
                        <Info k="Estabilidade" v={humanDays(info.stability)} />
                        <Info k="Dificuldade" v={`${info.difficulty.toFixed(1)}/10`} />
                        <Info k="Revisões" v={String(info.reps)} />
                        {info.lapses > 0 && <Info k="Lapsos" v={String(info.lapses)} />}
                      </dl>
                    )}
                    {ACTIONS.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => act(a.id)}
                        className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
                      >
                        <a.icon size={15} className="mt-0.5 shrink-0 text-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-fg">{a.label}</span>
                          <span className="block text-[0.75rem] leading-snug text-faint">{a.hint}</span>
                        </span>
                        {a.key && (
                          <span className="hidden pt-0.5 md:block">
                            <Kbd>{a.key}</Kbd>
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Frente: a palavra pelo TTS nativo. O alto-falante é pequeno e em teal
            suave — ele repete o áudio, não compete com a palavra. */}
        <div
          className={cn(
            "flex flex-col items-center text-center",
            revealed ? "mt-5" : "min-h-[12rem] justify-center gap-4 pt-2",
          )}
        >
          <button
            onClick={playWord}
            className="grid h-10 w-10 place-items-center rounded-full bg-brand-soft text-brand transition-colors hover:bg-brand hover:text-brand-fg"
            aria-label="Ouvir a palavra"
          >
            <Volume2 size={18} />
          </button>
          {!revealed && (
            <div>
              <p className="text-sm text-muted">Ouça e responda mentalmente</p>
              <p className="mt-1.5 hidden text-[0.8125rem] text-faint md:fine:block">
                <Kbd>Espaço</Kbd> revela, <Kbd>J</Kbd> repete o áudio
              </p>
            </div>
          )}

          {/* Verso: palavra em serifa coreana, sentido em itálico, a frase com a cena */}
          {revealed && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex w-full flex-col items-center"
            >
              <p
                className={cn(
                  "font-target-display mt-3.5 text-[3.25rem] leading-[1.1] text-fg md:text-[4rem]",
                  furigana && "leading-snug",
                )}
              >
                {card.target}
              </p>
              {card.reading && <p className="mt-1 text-sm text-faint">{card.reading}</p>}
              {card.translation && (
                <p className="line-trans mt-1.5 max-w-xl text-[1.25rem] text-muted md:text-[1.375rem]">
                  {card.translation}
                </p>
              )}
              {/* A forma como a palavra aparece na fala (있다 → 있) já vem
                  destacada dentro da frase-exemplo; repeti-la num chip solto
                  era o mesmo dado duas vezes. Só aparece se não há exemplo. */}
              {!card.context && card.newWords && card.newWords.length > 0 && (
                <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                  {card.newWords.map((w) => (
                    <span
                      key={w}
                      className="font-target rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-sm text-muted"
                    >
                      {w}
                    </span>
                  ))}
                </div>
              )}
              {card.context && (
                <div className="mt-6 w-full border-t border-line pt-5">
                  <ExampleLine
                    context={card.context}
                    surface={card.newWords?.[0] || card.target}
                    scene={sceneUrl}
                  />
                  {/* de onde a frase saiu: minuto exato do vídeo desta dose */}
                  <button
                    onClick={playFragment}
                    className={cn(
                      "mt-3 inline-flex items-center gap-2 text-xs font-medium text-muted transition-colors hover:text-brand",
                      sceneUrl ? "sm:ml-[9rem]" : "mx-auto",
                    )}
                  >
                    <Play size={11} className="fill-current text-brand" />
                    Ouvir na imersão
                    <span className="timecode text-faint">{fmtClock(card.startMs)}</span>
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </div>
      </div>

      {/* Avaliação: uma régua só, com o filete de cada nota. "Mostrar resposta"
          ocupa a mesma régua inteira, então o polegar não muda de lugar.
          Grudada no rodapé: num celular pequeno o verso (cena + frase) passa da
          tela e a nota ficava fora do alcance — o conteúdo esmaece por baixo. */}
      <div
        className="sticky bottom-0 z-10 -mx-5 w-[calc(100%+2.5rem)] px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:static md:mx-0 md:w-full md:p-0 md:pt-3"
        style={{ background: "linear-gradient(to top, var(--bg) 70%, transparent)" }}
      >
        {!revealed ? (
          <button
            onClick={reveal}
            className="h-14 w-full rounded-xl bg-brand text-sm font-semibold text-brand-fg transition-colors hover:bg-brand-strong"
          >
            Mostrar resposta
          </button>
        ) : (
          <div className="grid grid-cols-4 overflow-hidden rounded-xl border border-line bg-surface">
            {RATINGS.map((r, i) => {
              const meta = GRADE_META[r];
              return (
                <button
                  key={r}
                  onClick={() => grade(r)}
                  className={cn(
                    "relative flex flex-col items-center gap-0.5 px-1 pb-2.5 pt-3 transition-colors",
                    i > 0 && "border-l border-line",
                    meta.hover,
                  )}
                >
                  <span className={cn("absolute inset-x-0 top-0 h-0.5", meta.bar)} aria-hidden />
                  <span className={cn("whitespace-nowrap text-[0.8125rem] font-semibold", meta.color)}>
                    {meta.label}
                  </span>
                  <span className="text-[0.6875rem] tabular-nums text-faint">
                    {intervals?.[r]?.label ?? "—"}
                  </span>
                  <span className="mt-1 hidden md:fine:block">
                    <Kbd>{meta.key}</Kbd>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        <div className="mt-3 hidden flex-wrap justify-center gap-x-4 gap-y-1 text-[0.6875rem] text-faint md:fine:flex">
          <span className="inline-flex items-center gap-1"><Kbd>J</Kbd> repete o áudio</span>
          <span className="inline-flex items-center gap-1"><Kbd>Z</Kbd> desfaz a última nota</span>
          {onAction && (
            <>
              <span className="inline-flex items-center gap-1"><Kbd>-</Kbd> adia</span>
              <span className="inline-flex items-center gap-1"><Kbd>@</Kbd> suspende</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-faint">{k}</dt>
      <dd className="font-medium text-fg">{v}</dd>
    </div>
  );
}
