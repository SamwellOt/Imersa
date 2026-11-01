// Player de imersão: palco (vídeo com legenda por cima, ou áudio com faixa de
// legenda), modo Prime, cinema, «não entendi» e o dicionário da legenda.
// Peças: CaptionPanel · AudioStage · PlayerControls · TranscriptPanel (UI),
// useCinema · usePrime · useMediaController (hooks), playerLogic (regra pura).
import { useMemo, useState } from "react";
import { X, AlertTriangle } from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Dose, Segment } from "@/types/dose";
import { loadLemmaStatus, hasTokens, coverage, knownShare, needsPrime } from "@/lib/vocab";
import { MarkedText, type OnWord } from "@/components/ui/MarkedText";
import { marksOf, toggleMark } from "@/lib/marks";
import { WordPopover } from "./WordPopover";
import { useMediaController } from "./useMediaController";
import { IconButton, Button } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { useHotkeys, isInteractiveTarget, hasShortcutModifier, useMediaQuery } from "@/lib/hooks";
import { CaptionPanel } from "./CaptionPanel";
import { AudioStage } from "./AudioStage";
import { PlayerControls } from "./PlayerControls";
import { TranscriptPanel } from "./TranscriptPanel";
import { assetBaseOf } from "./playerLogic";
import { useCinema } from "./useCinema";
import { usePrime } from "./usePrime";

export function ImmersionPlayer({
  dose,
  mediaUrl,
  initialMs,
  onPositionChange,
  onListened,
  onEnded,
  onClose,
  compact,
}: {
  dose: Dose;
  mediaUrl: string;
  initialMs?: number;
  onPositionChange?: (ms: number) => void;
  onListened?: (deltaMs: number) => void;
  /** O vídeo chegou ao fim. */
  onEnded?: () => void;
  onClose?: () => void;
  compact?: boolean;
}) {
  // Retomou de uma posição salva? Oferece voltar ao começo (sem escondê-lo num menu).
  const resumedFrom = initialMs && initialMs > 15_000 ? initialMs : 0;
  const segments = dose.segments;
  const {
    subtitleMode, playbackRate, subtitleMarks, transcriptOpen, setTranscriptOpen, primedAdaptive,
  } = useApp();
  const [loop, setLoop] = useState(false);
  // Transcrição: no desktop é uma coluna ao lado do vídeo (preferência salva,
  // aberta por padrão); fechada, o vídeo volta ao centro. No celular é um
  // painel abaixo do vídeo, fechado por padrão e só desta sessão.
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [showTranscriptMobile, setShowTranscriptMobile] = useState(false);

  const isVideo = dose.media.kind === "video";
  const { cinema, cinemaManual, toggleCinema } = useCinema(isVideo);

  const showTranscript = !cinema && (isWide ? transcriptOpen : showTranscriptMobile);
  const toggleTranscript = () =>
    isWide ? setTranscriptOpen(!transcriptOpen) : setShowTranscriptMobile((v) => !v);

  // Legenda "conhecido/novo" (opcional): o status de cada palavra vem do SRS e
  // reage a escrita no banco (`useLiveQuery`) — avaliar cards numa outra aba já
  // muda a marca aqui. Dose sem tokens (build antigo) não oferece o destaque.
  const markable = useMemo(() => hasTokens(segments), [segments]);
  // O status das palavras serve às marcas, ao Prime adaptativo e ao dicionário.
  const lemmaStatus = useLiveQuery(
    () => (markable ? loadLemmaStatus(dose.language) : Promise.resolve(null)),
    [dose.language, markable],
  );
  const marks = markable && subtitleMarks ? (lemmaStatus ?? null) : null;

  // Prime adaptativo (opcional, Ajustes → Imersão): pausa só antes das falas com
  // alguma palavra ainda não fixada. Desligado, ou sem tokens: pausa em todas.
  const adaptive = subtitleMode === "primed" && primedAdaptive && markable && lemmaStatus != null;
  const wantsPrime = (sg: Segment) => !adaptive || needsPrime(sg, lemmaStatus);
  const primeCount = useMemo(
    () => (adaptive ? segments.filter((sg) => needsPrime(sg, lemmaStatus)).length : segments.length),
    [adaptive, segments, lemmaStatus],
  );

  // «Não entendi» (tecla N): falas marcadas desta dose
  const unclear = useLiveQuery(() => marksOf(dose.id), [dose.id]) ?? new Set<string>();

  // Dicionário: palavra tocada na legenda
  const [lookup, setLookup] = useState<{ lemma: string; rect: DOMRect } | null>(null);
  const assetBase = assetBaseOf(mediaUrl, dose.media.src);
  const assetUrl = (rel: string) => assetBase + rel;
  const knownPct = useMemo(() => {
    if (!marks) return null;
    const share = knownShare(coverage(segments, marks));
    return share == null ? null : Math.round(share * 100);
  }, [segments, marks]);

  const ctl = useMediaController(segments, {
    rate: playbackRate,
    loopSegment: loop,
    initialMs,
    onListened,
    onTimeUpdate: onPositionChange,
    onEnded,
  });

  const { line, primeSeg } = usePrime({
    segments, subtitleMode, ctl, wantsPrime, playbackRate, adaptive, lemmaStatus,
  });

  useHotkeys((e) => {
    // Se o foco está num botão/slider, o teclado é dele: senão o Espaço dava
    // play no vídeo em vez de ativar o controle focado.
    if (isInteractiveTarget(e) || hasShortcutModifier(e)) return;
    if (e.code === "Space") { e.preventDefault(); ctl.toggle(); }
    else if (e.key === "ArrowLeft") ctl.prevSegment();
    else if (e.key === "ArrowRight") ctl.nextSegment();
    else if (e.key.toLowerCase() === "r") ctl.replaySegment();
    else if (e.key.toLowerCase() === "l") setLoop((v) => !v);
    else if (e.key.toLowerCase() === "t") toggleTranscript();
    else if (e.key.toLowerCase() === "n") toggleUnclear();
    else if (e.key.toLowerCase() === "f" && isVideo) toggleCinema();
    // Esc sai do cinema pelo mesmo caminho do botão (na paisagem, `cinemaOff`)
    else if (e.key === "Escape" && cinema) toggleCinema();
  });

  const pct = ctl.durationMs > 0 ? (ctl.currentMs / ctl.durationMs) * 100 : 0;

  const curSeg = ctl.activeIndex >= 0 ? segments[ctl.activeIndex] : null;
  const curUnclear = !!curSeg && unclear.has(curSeg.id);
  function toggleUnclear() {
    if (curSeg) void toggleMark(dose.language, dose.id, curSeg.id);
  }
  const onWord: OnWord | undefined = markable
    ? (lemma, _seg, anchor) => {
        ctl.pause();
        setLookup({ lemma, rect: anchor.getBoundingClientRect() });
      }
    : undefined;

  const parts = (dose.source.parts ?? []).filter((p) => p.startMs > 0);

  return (
    <div
      data-theme={cinema ? "dark" : undefined}
      className={cn(
        "flex flex-col gap-4",
        cinema
          ? "fixed inset-0 z-50 bg-black text-fg"
          : showTranscript
            ? "lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-5"
            : "lg:mx-auto lg:w-full lg:max-w-4xl",
      )}
    >
      <div className={cn("flex min-w-0 flex-col gap-3", cinema && "min-h-0 flex-1 gap-1")}>
        {/* Palco: o quadro do vídeo com a legenda por cima, como no cinema. As
            histórias A0 são brancas e pastel — o filme fica num retângulo
            escuro próprio, e a legenda ganha um escurecimento só no rodapé. */}
        <div
          className={cn("elev-2 relative overflow-hidden rounded-xl bg-black", cinema && "grid min-h-0 flex-1 place-items-center rounded-none")}
          style={cinema ? { containerType: "size" } : undefined}
        >
          {/* No cinema o quadro é o maior 16:9 que cabe (`cqh` = altura do palco);
              a legenda fica no rodapé DO QUADRO, não no rodapé da tela — em
              retrato, o vídeo é uma faixa no meio e a legenda ficava lá embaixo. */}
          <div
            className={cn("relative w-full", cinema && "aspect-video")}
            style={cinema ? { width: "min(100%, calc(100cqh * 16 / 9))" } : undefined}
          >
          {onClose && (
            <IconButton
              label="Fechar"
              onClick={onClose}
              className="absolute right-2 top-2 z-20 bg-black/50 text-white hover:bg-black/70 hover:text-white"
            >
              <X size={16} />
            </IconButton>
          )}

          {ctl.error && (
            <div className="flex flex-col items-center gap-3 bg-surface px-6 py-10 text-center">
              <AlertTriangle size={20} className="text-hard" />
              <div>
                <p className="text-sm font-medium">Não foi possível carregar a mídia</p>
                <p className="mx-auto mt-1 max-w-[42ch] text-xs leading-relaxed text-muted">
                  O arquivo desta dose não respondeu. Verifique se a pasta{" "}
                  <code className="text-brand">content/</code> está acessível.
                </p>
              </div>
              <Button size="sm" variant="secondary" onClick={ctl.retry}>
                Tentar de novo
              </Button>
            </div>
          )}

          {isVideo ? (
            <video
              ref={ctl.mediaRef as React.RefObject<HTMLVideoElement>}
              src={mediaUrl}
              className={cn(
                "aspect-video w-full bg-black object-contain",
                ctl.error && "hidden",
                !cinema && (compact ? "max-h-[34vh]" : "max-h-[62vh]"),
              )}
              playsInline
            />
          ) : (
            <>
              <audio ref={ctl.mediaRef as React.RefObject<HTMLAudioElement>} src={mediaUrl} preload="metadata" />
              <div className="bg-surface px-6 pt-6">
                <p className="font-target text-center text-sm text-faint">
                  {dose.titleTarget ?? dose.title}
                </p>
                <AudioStage pct={pct} />
              </div>
            </>
          )}

          {isVideo && !ctl.error ? (
            <>
              {/* Prime: o quadro escurece e só o significado em PT fica, até o play */}
              {subtitleMode === "primed" && (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 px-8 text-center transition-opacity duration-300",
                    primeSeg && !ctl.playing ? "opacity-100" : "opacity-0",
                  )}
                >
                  {primeSeg && (
                    <div className="max-w-2xl">
                      <p className="label-eyebrow text-white/70">Leia e dê play</p>
                      <p className="line-trans mt-2 text-balance text-[1.375rem] text-white md:text-[1.75rem]">
                        {primeSeg.translation || primeSeg.target}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {/* legenda sobre o quadro */}
              {subtitleMode !== "primed" && subtitleMode !== "off" && line && (
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-4 pt-12 text-center md:px-10 md:pb-5"
                  style={{ background: "linear-gradient(to top, rgb(8 12 14 / 0.84), rgb(8 12 14 / 0))" }}
                >
                  {(subtitleMode === "target" || subtitleMode === "both") && (
                    <p className="line-target pointer-events-auto text-balance text-[1.375rem] font-medium text-white [text-shadow:0_1px_3px_rgb(0_0_0/0.55)] md:text-[1.75rem]">
                      <MarkedText seg={line} status={marks} onWord={onWord} />
                    </p>
                  )}
                  {(subtitleMode === "translation" || subtitleMode === "both") && line.translation && (
                    <p
                      className={cn(
                        "line-trans mx-auto max-w-2xl text-balance text-white/88 [text-shadow:0_1px_3px_rgb(0_0_0/0.55)]",
                        subtitleMode === "both" ? "mt-1 text-[1.0625rem] md:text-[1.1875rem]" : "text-[1.375rem] md:text-[1.625rem]",
                      )}
                    >
                      {line.translation}
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            !ctl.error && (
              /* Áudio: sem quadro para escrever por cima, a legenda fica numa faixa própria. */
              <div className="border-t border-line bg-surface-2 px-5 py-4">
                <CaptionPanel mode={subtitleMode} line={line} primeSeg={primeSeg} playing={ctl.playing} marks={marks} onWord={onWord} />
              </div>
            )
          )}
          </div>
        </div>

        <PlayerControls
          ctl={ctl}
          pct={pct}
          parts={parts}
          cinema={cinema}
          cinemaManual={cinemaManual}
          toggleCinema={toggleCinema}
          isVideo={isVideo}
          loop={loop}
          setLoop={setLoop}
          markable={markable}
          primeCount={primeCount}
          segmentCount={segments.length}
          curSeg={curSeg}
          curUnclear={curUnclear}
          toggleUnclear={toggleUnclear}
          showTranscript={showTranscript}
          toggleTranscript={toggleTranscript}
          resumedFrom={resumedFrom}
        />
      </div>

      {showTranscript && (
        <TranscriptPanel
          segments={segments}
          activeIndex={ctl.activeIndex}
          onSeek={(i) => ctl.goToSegment(i)}
          subtitleMode={subtitleMode}
          marks={marks}
          unclear={unclear}
          onWord={onWord}
          knownPct={knownPct}
        />
      )}
      {lookup && (
        <WordPopover
          dose={dose}
          lemma={lookup.lemma}
          anchor={lookup.rect}
          assetUrl={assetUrl}
          onClose={() => setLookup(null)}
        />
      )}
    </div>
  );
}
