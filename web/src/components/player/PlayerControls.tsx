// Barra de controles do player: linha do tempo (arrastável, com o início de
// cada parte), transporte, seletor de legendas, velocidade, marcas, Prime
// adaptativo, «não entendi», tela cheia, transcrição e a linha de atalhos.
import { useRef } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Repeat, RotateCcw, List, Rewind,
  Highlighter, Maximize2, Minimize2, CircleHelp, Filter,
} from "lucide-react";
import type { Segment, SourcePart } from "@/types/dose";
import { Segmented } from "@/components/ui/Segmented";
import { IconButton, Kbd } from "@/components/ui/primitives";
import { cn, clamp, fmtClock } from "@/lib/utils";
import { useApp } from "@/lib/store";
import type { useMediaController } from "./useMediaController";
import { SUB_OPTS } from "./subtitleOptions";
import { formatRate, nextRate } from "./playerLogic";

// Botão de controle num player de menos de 24rem (celular de 360 px): 32 px.
const NARROW = "@max-[24rem]:h-8 @max-[24rem]:w-8";

export function PlayerControls({
  ctl, pct, parts, cinema, cinemaManual, toggleCinema, isVideo, loop, setLoop, markable, primeCount,
  segmentCount, curSeg, curUnclear, toggleUnclear, showTranscript, toggleTranscript, resumedFrom,
}: {
  ctl: ReturnType<typeof useMediaController>;
  /** Progresso da mídia, 0..100. */
  pct: number;
  /** Partes da lição (vídeos emendados) que começam depois do 0. */
  parts: SourcePart[];
  cinema: boolean;
  cinemaManual: boolean;
  toggleCinema: () => void;
  isVideo: boolean;
  loop: boolean;
  setLoop: (fn: (v: boolean) => boolean) => void;
  markable: boolean;
  primeCount: number;
  segmentCount: number;
  curSeg: Segment | null;
  curUnclear: boolean;
  toggleUnclear: () => void;
  showTranscript: boolean;
  toggleTranscript: () => void;
  resumedFrom: number;
}) {
  const {
    subtitleMode, setSubtitleMode, playbackRate, setPlaybackRate, subtitleMarks, setSubtitleMarks,
    primedAdaptive, setPrimedAdaptive,
  } = useApp();

  // Draggable seek (mouse + touch via pointer events).
  const seekDragRef = useRef(false);
  const seekFromX = (el: HTMLElement, clientX: number) => {
    if (!ctl.durationMs) return;
    const r = el.getBoundingClientRect();
    ctl.seekMs(clamp((clientX - r.left) / r.width, 0, 1) * ctl.durationMs);
  };

  // Controles: uma barra, não um card. `@container`: os pontos de quebra abaixo
  // medem a LARGURA DO PLAYER (que encolhe com a transcrição aberta), não a da janela.
  return (
    <div className={cn("@container px-1", cinema && "shrink-0 px-[max(1rem,env(safe-area-inset-left))] pb-[max(0.5rem,env(safe-area-inset-bottom))]")}>
      {/* linha do tempo, com o início de cada história marcado */}
      <div className="flex items-center gap-3">
        <span className="timecode w-10 shrink-0 text-right text-fg">
          {fmtClock(ctl.currentMs)}
        </span>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Progresso da mídia"
          aria-valuemin={0}
          aria-valuemax={Math.round(ctl.durationMs / 1000)}
          aria-valuenow={Math.round(ctl.currentMs / 1000)}
          className="group relative h-6 flex-1 cursor-pointer touch-none select-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") ctl.seekMs(Math.max(0, ctl.currentMs - 5000));
            if (e.key === "ArrowRight") ctl.seekMs(Math.min(ctl.durationMs, ctl.currentMs + 5000));
          }}
          onPointerDown={(e) => {
            seekDragRef.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromX(e.currentTarget, e.clientX);
          }}
          onPointerMove={(e) => {
            if (seekDragRef.current) seekFromX(e.currentTarget, e.clientX);
          }}
          onPointerUp={(e) => {
            seekDragRef.current = false;
            try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ }
          }}
          onPointerCancel={() => { seekDragRef.current = false; }}
        >
          <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-surface-3">
            <div className="absolute inset-y-0 left-0 rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
          {ctl.durationMs > 0 &&
            parts.map((p) => (
              <span
                key={p.startMs}
                title={p.title ?? undefined}
                className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-line-strong"
                style={{ left: `${(p.startMs / ctl.durationMs) * 100}%` }}
              />
            ))}
          <div
            className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: `${pct}%` }}
          />
        </div>
        <span className="timecode w-10 shrink-0 text-faint">
          {fmtClock(ctl.durationMs)}
        </span>
      </div>

      {/* Três colunas de largura igual nas laterais: o seletor de legendas fica
          no centro REAL do vídeo (alinhado com a linha de atalhos abaixo), e não
          no meio do espaço que sobra entre um grupo de 5 botões e um de 3. */}
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 @[40rem]:grid @[40rem]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        {/* Em container estreito (celular de 360 px) os botões encolhem para
            a linha não quebrar em duas: transporte à esquerda, ajustes à
            direita, legendas na linha de baixo. */}
        <div className="flex items-center gap-0.5 @max-[24rem]:gap-0 @[40rem]:justify-self-start">
          <IconButton label="Linha anterior (←)" onClick={ctl.prevSegment} className={NARROW}>
            <SkipBack size={16} />
          </IconButton>
          <button
            onClick={ctl.toggle}
            className="mx-1 grid h-10 w-10 place-items-center rounded-full bg-brand text-brand-fg transition-colors hover:bg-brand-strong"
            aria-label={ctl.playing ? "Pausar" : "Reproduzir"}
          >
            {ctl.playing ? <Pause size={18} /> : <Play size={18} className="translate-x-[1px]" />}
          </button>
          <IconButton label="Próxima linha (→)" onClick={ctl.nextSegment} className={NARROW}>
            <SkipForward size={16} />
          </IconButton>
          <IconButton label="Repetir linha (R)" onClick={ctl.replaySegment} className={NARROW}>
            <RotateCcw size={15} />
          </IconButton>
          <IconButton label="Repetir em loop (L)" active={loop} onClick={() => setLoop((v) => !v)} className={NARROW}>
            <Repeat size={15} />
          </IconButton>
        </div>

        <div className="no-scrollbar order-3 w-full overflow-x-auto @[40rem]:order-none @[40rem]:w-auto @[40rem]:justify-self-center">
          <div className="mx-auto w-fit">
            <Segmented value={subtitleMode} onChange={setSubtitleMode} options={SUB_OPTS} size="sm" />
          </div>
        </div>

        <div className="flex items-center gap-1 @max-[24rem]:gap-0 @[40rem]:justify-self-end">
          <button
            onClick={() => {
              const next = nextRate(playbackRate);
              setPlaybackRate(next);
              ctl.setRate(next);
            }}
            className="timecode h-9 rounded-lg px-2.5 font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg @max-[24rem]:h-8 @max-[24rem]:px-1.5"
            title="Velocidade de reprodução"
          >
            {formatRate(playbackRate)}×
          </button>
          {markable && (
            <IconButton
              label={subtitleMarks ? "Ocultar marcas de palavra" : "Marcar palavras por conhecimento"}
              active={subtitleMarks}
              onClick={() => setSubtitleMarks(!subtitleMarks)}
              className={NARROW}
            >
              <Highlighter size={16} />
            </IconButton>
          )}
          {markable && subtitleMode === "primed" && (
            <IconButton
              label={
                primedAdaptive
                  ? `Prime adaptativo ligado: pausa em ${primeCount} de ${segmentCount} falas (só as com palavra nova)`
                  : "Prime adaptativo: pausar só nas falas com palavra nova"
              }
              active={primedAdaptive}
              onClick={() => setPrimedAdaptive(!primedAdaptive)}
              className={NARROW}
            >
              <Filter size={15} />
            </IconButton>
          )}
          <IconButton
            label={curUnclear ? "Desmarcar «não entendi» (N)" : "Não entendi esta fala (N)"}
            active={curUnclear}
            onClick={toggleUnclear}
            disabled={!curSeg}
            className={NARROW}
          >
            <CircleHelp size={16} />
          </IconButton>
          {isVideo && (
            <IconButton
              label={cinema ? "Sair da tela cheia (Esc)" : "Tela cheia (F)"}
              active={cinemaManual}
              onClick={toggleCinema}
              className={NARROW}
            >
              {cinema ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </IconButton>
          )}
          <IconButton
            label={showTranscript ? "Fechar a transcrição (T)" : "Abrir a transcrição (T)"}
            active={showTranscript}
            onClick={toggleTranscript}
            className={cn(NARROW, cinema && "hidden")}
          >
            <List size={16} />
          </IconButton>
        </div>
      </div>

      {/* Atalhos: estavam implementados e invisíveis. */}
      <div className={cn("mt-2.5 hidden flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-[0.6875rem] text-faint", !cinema && "md:fine:flex")}>
        <span className="inline-flex items-center gap-1"><Kbd>Espaço</Kbd> tocar/pausar</span>
        <span className="inline-flex items-center gap-1"><Kbd>←</Kbd><Kbd>→</Kbd> fala</span>
        <span className="inline-flex items-center gap-1"><Kbd>R</Kbd> repetir</span>
        <span className="inline-flex items-center gap-1"><Kbd>L</Kbd> loop</span>
        <span className="inline-flex items-center gap-1"><Kbd>T</Kbd> transcrição</span>
        <span className="inline-flex items-center gap-1"><Kbd>N</Kbd> não entendi</span>
        <span className="inline-flex items-center gap-1"><Kbd>F</Kbd> tela cheia</span>
      </div>

      {resumedFrom > 0 && !cinema && (
        <button
          onClick={() => ctl.seekMs(0)}
          className="mx-auto mt-2 flex items-center gap-1.5 text-xs text-muted transition-colors hover:text-fg"
        >
          <Rewind size={12} /> Retomado em {fmtClock(resumedFrom)}, voltar ao início
        </button>
      )}
    </div>
  );
}
