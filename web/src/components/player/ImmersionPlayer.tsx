import { useEffect, useMemo, useRef, useState } from "react";
import {
  Play, Pause, SkipBack, SkipForward, Repeat, RotateCcw, List, X, AlertTriangle, Rewind,
  Highlighter, Maximize2, Minimize2, CircleHelp, Filter,
} from "lucide-react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Dose, Segment } from "@/types/dose";
import { loadLemmaStatus, hasTokens, coverage, knownShare, needsPrime, type LemmaStatus } from "@/lib/vocab";
import { MarkedText, MarkLegend, type OnWord } from "@/components/ui/MarkedText";
import { marksOf, toggleMark } from "@/lib/marks";
import { WordPopover } from "./WordPopover";
import { useMediaController } from "./useMediaController";
import { TranscriptList } from "./TranscriptList";
import { Segmented } from "@/components/ui/Segmented";
import { IconButton, Kbd, Button } from "@/components/ui/primitives";
import { cn, clamp, fmtClock } from "@/lib/utils";
import { useApp, type SubtitleMode } from "@/lib/store";
import { useHotkeys, isInteractiveTarget, hasShortcutModifier, useMediaQuery } from "@/lib/hooks";

const SUB_OPTS: { value: SubtitleMode; label: string }[] = [
  { value: "target", label: "Alvo" },
  { value: "translation", label: "PT" },
  { value: "both", label: "Ambas" },
  { value: "primed", label: "Primed" },
  { value: "off", label: "Off" },
];

const RATES = [0.7, 0.85, 1, 1.15, 1.35];
// Botão de controle num player de menos de 24rem (celular de 360 px): 32 px.
const NARROW = "@max-[24rem]:h-8 @max-[24rem]:w-8";
// Prime: 0,1 s antes de cada fala o vídeo pausa e mostra o significado em PT
// (idioma nativo). O aluno lê, dá play e ouve a fala em idioma-alvo "às cegas".
const PRIME_LEAD_MS = 100;

const BAR_COUNT = 72;
// Alturas determinísticas: uma "onda" estável, não uma animação aleatória.
const BARS = Array.from({ length: BAR_COUNT }, (_, i) => {
  const a = Math.sin(i * 0.55) * 0.5 + Math.sin(i * 0.17 + 1.3) * 0.3 + Math.sin(i * 1.9) * 0.2;
  return 0.22 + Math.abs(a) * 0.78;
});

const TARGET_CLS =
  "line-target sub-target sub-shadow text-[1.375rem] font-medium md:text-[1.75rem]";

/**
 * Painel de legendas, logo abaixo da mídia.
 *
 * Fica FORA do componente do player de propósito: declarado dentro dele, o React
 * via um tipo de componente novo a cada quadro de vídeo e remontava o painel
 * inteiro ~60 vezes por segundo (texto piscando e trabalho de layout à toa).
 */
function CaptionPanel({
  mode, line, primeSeg, playing, marks, onWord,
}: {
  mode: SubtitleMode;
  line: Segment | null;
  primeSeg: Segment | null;
  playing: boolean;
  /** Status por lema quando a legenda "conhecido/novo" está ligada; null = desligada. */
  marks: LemmaStatus | null;
  onWord?: OnWord;
}) {
  // A altura é reservada (min-h + centralização) para a troca de legenda não
  // empurrar os controles para baixo a cada fala.
  const box = "flex min-h-[7rem] flex-col items-center justify-center gap-2 text-center md:min-h-[8rem]";

  if (mode === "off") {
    return (
      <div className={box}>
        <span className="text-xs text-faint">Legendas desligadas</span>
      </div>
    );
  }

  if (mode === "primed") {
    // 0,1 s antes de cada fala o vídeo pausa e mostra o significado em PT; o
    // aluno lê, dá play e ouve a fala "às cegas" (a legenda some na hora dela).
    return (
      <div className={cn(box, "gap-2.5")}>
        {primeSeg ? (
          <>
            <span className="label-eyebrow text-brand">
              Prime{!playing && " · leia e dê play"}
            </span>
            <p className="sub-target sub-shadow max-w-2xl text-balance text-lg leading-snug md:text-xl">
              {primeSeg.translation || primeSeg.target}
            </p>
          </>
        ) : (
          <span className="text-xs text-faint">
            {playing ? "Ouvindo…" : "Dê play para continuar"}
          </span>
        )}
      </div>
    );
  }

  const showTarget = mode === "target" || mode === "both";
  const showTrans = mode === "translation" || mode === "both";
  return (
    <div className={box}>
      {line ? (
        <>
          {showTarget && (
            <p className={cn(TARGET_CLS, "text-balance")}>
              <MarkedText seg={line} status={marks} onWord={onWord} />
            </p>
          )}
          {showTrans && line.translation && (
            <p
              className={cn(
                "sub-shadow max-w-2xl text-balance leading-snug",
                showTarget
                  ? "sub-trans text-[0.9375rem] md:text-base"
                  : "sub-target text-lg font-medium md:text-xl",
              )}
            >
              {line.translation}
            </p>
          )}
        </>
      ) : (
        <span className="text-xs text-faint">· · ·</span>
      )}
    </div>
  );
}

/** Palco do áudio: forma de onda estática que se colore conforme o progresso. */
function AudioStage({ pct }: { pct: number }) {
  const played = Math.round((pct / 100) * BAR_COUNT);
  return (
    <div className="flex h-20 items-center justify-center gap-[3px]" aria-hidden>
      {BARS.map((h, i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] rounded-full transition-colors",
            i < played ? "bg-brand" : "bg-surface-3",
          )}
          style={{ height: `${h * 100}%` }}
        />
      ))}
    </div>
  );
}

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
    subtitleMode, setSubtitleMode, playbackRate, setPlaybackRate, subtitleMarks, setSubtitleMarks,
    transcriptOpen, setTranscriptOpen, primedAdaptive, setPrimedAdaptive,
  } = useApp();
  const [loop, setLoop] = useState(false);
  // Transcrição: no desktop é uma coluna ao lado do vídeo (preferência salva,
  // aberta por padrão); fechada, o vídeo volta ao centro. No celular é um
  // painel abaixo do vídeo, fechado por padrão e só desta sessão.
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [showTranscriptMobile, setShowTranscriptMobile] = useState(false);

  // Cinema: o quadro toma a tela inteira, com os controles por cima de fundo
  // preto (paleta escura forçada). Entra sozinho no celular em paisagem — ali o
  // cabeçalho da dose comia um terço da altura e os controles caíam abaixo da
  // dobra — e à mão pelo botão de tela cheia. Onde o navegador deixa, também
  // pede tela cheia de verdade (esconde a barra de endereço); no iPhone o
  // pedido é ignorado sem erro e fica só o layout.
  const phoneLandscape = useMediaQuery("(orientation: landscape) and (max-height: 520px)");
  const [cinemaManual, setCinemaManual] = useState(false);
  const isVideo = dose.media.kind === "video";
  const cinema = isVideo && (cinemaManual || phoneLandscape);
  const setCinema = (on: boolean) => {
    setCinemaManual(on);
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    try {
      if (on && !document.fullscreenElement) {
        void document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
      } else if (!on && document.fullscreenElement) {
        void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
      }
    } catch { /* sem tela cheia neste navegador */ }
  };
  // O usuário saiu da tela cheia pelo navegador (Esc, gesto de voltar): o
  // layout acompanha. E enquanto o cinema está aberto a página não rola.
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setCinemaManual(false); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!cinema) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [cinema]);

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
  const assetBase = mediaUrl.slice(0, Math.max(0, mediaUrl.length - dose.media.src.length));
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

  // A fala para a qual o Prime pausou. A legenda em PT precisa aparecer pela
  // PAUSA, não pelo tempo do vídeo: o `setTimeout` (e o próprio `pause()`) param
  // uns milissegundos antes da janela de 100 ms, e aí `startMs − cur` dava 103,
  // a janela não abria e a tela mostrava "Dê play" sem legenda nenhuma. Fica
  // fixa até a fala começar (o áudio revela o que o aluno acabou de ler).
  const [primeHold, setPrimeHold] = useState<Segment | null>(null);

  // "Sticky" current line (persists through the small gaps between lines so
  // captions don't flicker) + the next line + the 0.1s "prime window" before it.
  const { line, primeSeg } = useMemo(() => {
    const cur = ctl.currentMs;
    const i = ctl.activeIndex; // already sticky (holds current/most-recent line)
    const ln: Segment | null = i >= 0 ? segments[i] : null;
    let nxt: Segment | null = null;
    for (let k = Math.max(0, i); k < segments.length; k++) {
      if (segments[k].startMs > cur) {
        nxt = segments[k];
        break;
      }
    }
    // prime window: within 0.1s before the next line begins — ou a fala em que
    // o Prime pausou, enquanto ela ainda não começou
    const prime = nxt && nxt.startMs - cur <= PRIME_LEAD_MS ? nxt : null;
    const held = primeHold && cur < primeHold.startMs ? primeHold : null;
    return { line: ln, primeSeg: prime ?? held };
  }, [ctl.currentMs, ctl.activeIndex, segments, primeHold]);

  // a fala começou (ou o modo mudou): solta a legenda fixada
  useEffect(() => {
    if (primeHold && (subtitleMode !== "primed" || ctl.currentMs >= primeHold.startMs)) {
      setPrimeHold(null);
    }
  }, [primeHold, subtitleMode, ctl.currentMs]);

  // Prime mode: pause 0.1s before each line so the learner reads the target text,
  // then resumes to hear it (subtitle hides once the line starts).
  const primePausedRef = useRef<string | null>(null);
  // Por relógio: a pausa é um `setTimeout` calculado do tempo da mídia e da
  // velocidade até `startMs − 100 ms` da próxima fala. O caminho por quadro
  // (abaixo) dependia de um tique do rAF cair dentro da janela de 100 ms — com
  // a aba em segundo plano o rAF para, o `timeupdate` vem ~1×/s e a fala
  // passava sem pausar. Ele continua como reserva; a ref evita pausar duas vezes.
  useEffect(() => {
    if (subtitleMode !== "primed" || !ctl.playing) return;
    const el = ctl.mediaRef.current;
    if (!el) return;
    const cur = el.currentTime * 1000;
    // a próxima fala cuja janela ainda não passou (ao retomar da pausa, a fala
    // que acabou de ser lida fica para trás e o alvo vira a seguinte)
    const nxt = segments.find(
      (s) => s.startMs - PRIME_LEAD_MS > cur + 30 && s.id !== primePausedRef.current && wantsPrime(s),
    );
    if (!nxt) return;
    const target = nxt.startMs - PRIME_LEAD_MS;
    const delay = (target - cur) / (el.playbackRate || 1);
    const t = setTimeout(() => {
      if (primePausedRef.current === nxt.id) return;
      primePausedRef.current = nxt.id;
      setPrimeHold(nxt);
      ctl.pause();
      // o timer chega uns ms antes ou depois do alvo: encosta o vídeo em
      // exatamente 0,1 s antes da fala, para o play retomar com a folga certa
      if (Math.abs(el.currentTime * 1000 - target) > 40) el.currentTime = target / 1000;
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleMode, ctl.playing, ctl.activeIndex, playbackRate, segments, adaptive, lemmaStatus]);
  useEffect(() => {
    if (subtitleMode !== "primed") {
      primePausedRef.current = null;
      return;
    }
    if (ctl.playing && primeSeg && primePausedRef.current !== primeSeg.id && wantsPrime(primeSeg)) {
      primePausedRef.current = primeSeg.id;
      setPrimeHold(primeSeg);
      ctl.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtitleMode, ctl.playing, primeSeg?.id]);

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
    else if (e.key.toLowerCase() === "f" && isVideo) setCinema(!cinemaManual);
    else if (e.key === "Escape" && cinemaManual) setCinema(false);
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

  // Draggable seek (mouse + touch via pointer events).
  const seekDragRef = useRef(false);
  const seekFromX = (el: HTMLElement, clientX: number) => {
    if (!ctl.durationMs) return;
    const r = el.getBoundingClientRect();
    ctl.seekMs(clamp((clientX - r.left) / r.width, 0, 1) * ctl.durationMs);
  };

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

        {/* Controles: uma barra, não um card. `@container`: os pontos de quebra
            abaixo medem a LARGURA DO PLAYER (que encolhe com a transcrição aberta),
            não a da janela. */}
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
                  // a próxima acima da atual — uma velocidade persistida que não
                  // está mais na lista (versão antiga) não cai em -1 nem pula para 0,7×
                  const next = RATES.find((r) => r > playbackRate + 1e-6) ?? RATES[0];
                  setPlaybackRate(next);
                  ctl.setRate(next);
                }}
                className="timecode h-9 rounded-lg px-2.5 font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg @max-[24rem]:h-8 @max-[24rem]:px-1.5"
                title="Velocidade de reprodução"
              >
                {playbackRate.toFixed(2).replace(/\.?0+$/, "")}×
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
                      ? `Prime adaptativo ligado: pausa em ${primeCount} de ${segments.length} falas (só as com palavra nova)`
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
                  onClick={() => setCinema(!cinema)}
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
      </div>

      {/* Transcrição: coluna ao lado do vídeo a partir de lg (colapsável —
          fechada, o vídeo ocupa o centro); abaixo disso é o painel que o
          ícone abre por baixo dos controles. */}
      {showTranscript && (
      <aside
        className="flex max-h-[46vh] flex-col overflow-hidden rounded-xl border border-line bg-surface lg:sticky lg:top-20 lg:max-h-[calc(100dvh-7rem)]"
        aria-label="Transcrição"
      >
        <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
          <span className="text-[0.8125rem] font-semibold">Transcrição</span>
          <span className="text-[0.6875rem] text-faint">
            {segments.length} falas
            {knownPct != null && `, ${knownPct}% já fixado`}
            {unclear.size > 0 && `, ${unclear.size} não ${unclear.size === 1 ? "entendida" : "entendidas"}`}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <TranscriptList
            segments={segments}
            activeIndex={ctl.activeIndex}
            onSeek={(i) => ctl.goToSegment(i)}
            showTranslation={subtitleMode !== "target" && subtitleMode !== "off"}
            marks={marks}
            unclear={unclear}
            onWord={onWord}
          />
        </div>
        {marks && (
          <div className="border-t border-line px-4 py-2.5">
            <MarkLegend />
          </div>
        )}
      </aside>
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
