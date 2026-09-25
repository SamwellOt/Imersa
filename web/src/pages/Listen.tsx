import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pause, Play, SkipBack, SkipForward, WifiOff } from "lucide-react";
import type { Dose, Segment } from "@/types/dose";
import { resolveDose, mediaUrl, langOfDoseId } from "@/lib/content";
import { logImmersion } from "@/lib/srs";
import { hasTokens } from "@/lib/vocab";
import { useApp } from "@/lib/store";
import { useAsync, useDocumentTitle, useHotkeys, isInteractiveTarget, hasShortcutModifier } from "@/lib/hooks";
import { BRAND } from "@/lib/brand";
import { cn, fmtClock } from "@/lib/utils";
import { LoadingScreen, ErrorScreen, EmptyState } from "@/components/ui/feedback";
import { MarkedText } from "@/components/ui/MarkedText";
import { WordPopover } from "@/components/player/WordPopover";

const RATES = [0.85, 1, 1.15, 1.35];
/** Tempo ouvido vira evento de imersão em blocos (e ao sair). */
const FLUSH_MS = 30_000;

/** Instante do áudio condensado → instante no vídeo original (via `condensedMap`). */
function toOriginal(map: [number, number, number][], ms: number): number {
  let lo = 0, hi = map.length - 1, k = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid][0] <= ms) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const [c, o, d] = map[k] ?? [0, 0, 0];
  return o + Math.min(Math.max(0, ms - c), d);
}

function toCondensed(map: [number, number, number][], orig: number): number {
  for (const [c, o, d] of map) if (orig < o + d) return c + Math.max(0, orig - o);
  return 0;
}

function segmentAt(segs: Segment[], orig: number): number {
  let best = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startMs <= orig + 120) best = i;
    else break;
  }
  return best;
}

/**
 * Escuta: o áudio condensado da lição (só as falas, sem silêncio nem trechos sem
 * legenda) para reouvir a dose — no ônibus, lavando a louça. O arquivo é baixado
 * inteiro (não por `Range`), então o service worker guarda e ele toca offline.
 * A legenda acompanha pelo mapa condensado → original; tocar numa palavra abre o
 * dicionário, como no player. O tempo ouvido conta como imersão da lição.
 */
export function Listen() {
  const { doseId = "" } = useParams();
  const activeLanguage = useApp((s) => s.activeLanguage);
  const lang = langOfDoseId(doseId) ?? activeLanguage ?? "";
  const nav = useNavigate();
  const { data, loading, error, reload } = useAsync(() => resolveDose(lang, doseId), [lang, doseId]);
  useDocumentTitle(`Escuta${data ? " · " + data.dose.title : ""} · ${BRAND.name}`);

  if (loading) return <LoadingScreen label="Abrindo a escuta…" />;
  if (error || !data) return <ErrorScreen message={error?.message ?? "Dose não encontrada"} onRetry={reload} backHome />;
  const src = data.dose.media.condensedAudioSrc;
  if (!src || !data.dose.media.condensedMap?.length) {
    return (
      <div className="mx-auto max-w-lg px-5 pt-16">
        <EmptyState title="Esta lição ainda não tem áudio condensado" description="Ele é gerado pela fábrica de lições (dose_factory enrich)." />
      </div>
    );
  }
  return (
    <ListenPlayer
      dose={data.dose}
      audioUrl={mediaUrl(lang, data.path, src)}
      assetUrl={(rel) => mediaUrl(lang, data.path, rel)}
      onBack={() => (window.history.length > 1 ? nav(-1) : nav("/"))}
    />
  );
}

function ListenPlayer({
  dose, audioUrl, assetUrl, onBack,
}: {
  dose: Dose;
  audioUrl: string;
  assetUrl: (rel: string) => string;
  onBack: () => void;
}) {
  const map = dose.media.condensedMap!;
  const total = map.length ? map[map.length - 1][0] + map[map.length - 1][2] : 0;
  const audioRef = useRef<HTMLAudioElement>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [ms, setMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [showPt, setShowPt] = useState(true);
  const [lookup, setLookup] = useState<{ lemma: string; rect: DOMRect } | null>(null);
  const markable = useMemo(() => hasTokens(dose.segments), [dose.segments]);

  // arquivo inteiro → blob: sem `Range`, o service worker guarda uma cópia
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    fetch(audioUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => {
        if (!alive) return;
        url = URL.createObjectURL(b);
        setBlobUrl(url);
      })
      .catch((e) => alive && setLoadErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [audioUrl]);

  // imersão: soma o tempo ouvido e grava em blocos
  const pendingMs = useRef(0);
  const lastT = useRef<number | null>(null);
  const flush = () => {
    const n = pendingMs.current;
    pendingMs.current = 0;
    if (n > 1000) void logImmersion(dose.language, n, dose.id);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    // fechar a aba no meio da escuta também registra o que já tocou (até 30 s)
    const onHide = () => flushRef.current();
    addEventListener("pagehide", onHide);
    return () => {
      removeEventListener("pagehide", onHide);
      flushRef.current();
    };
  }, []);

  const onTime = () => {
    const a = audioRef.current;
    if (!a) return;
    const t = a.currentTime * 1000;
    if (lastT.current != null && !a.paused) {
      const d = t - lastT.current;
      if (d > 0 && d < 2000) pendingMs.current += d / (a.playbackRate || 1);
      if (pendingMs.current >= FLUSH_MS) flush();
    }
    lastT.current = t;
    setMs(t);
  };

  const orig = toOriginal(map, ms);
  const idx = segmentAt(dose.segments, orig);
  const seg = idx >= 0 ? dose.segments[idx] : null;

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) void a.play();
    else a.pause();
  };
  const jumpSeg = (delta: number) => {
    const a = audioRef.current;
    if (!a) return;
    const k = Math.min(Math.max(0, (idx < 0 ? 0 : idx) + delta), dose.segments.length - 1);
    a.currentTime = toCondensed(map, dose.segments[k].startMs) / 1000;
  };
  useHotkeys((e) => {
    if (isInteractiveTarget(e) || hasShortcutModifier(e)) return;
    if (e.code === "Space") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") jumpSeg(-1);
    else if (e.key === "ArrowRight") jumpSeg(1);
  });

  const pct = total ? (ms / total) * 100 : 0;

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="bar-solid pt-safe sticky top-0 z-30 border-b border-line">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4">
          <button
            onClick={onBack}
            className="-ml-1 grid h-10 w-10 shrink-0 place-items-center rounded-lg md:ml-0 md:h-8 md:w-8 text-faint transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label="Voltar"
          >
            <ArrowLeft size={16} />
          </button>
          <div className="min-w-0 flex-1 py-2.5">
            <div className="truncate text-[0.8125rem] font-medium">{dose.title}</div>
            <div className="text-[0.6875rem] text-faint">
              Escuta · {fmtClock(total)} de fala, de {fmtClock(dose.media.durationSec * 1000)} de vídeo
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-5 py-10">
        <div className="min-h-[9rem] text-center">
          {seg ? (
            <>
              <p className="line-target text-balance text-[1.5rem] leading-snug md:text-[1.875rem]">
                <MarkedText
                  seg={seg}
                  status={null}
                  onWord={markable ? (lemma, _s, el) => {
                    audioRef.current?.pause();
                    setLookup({ lemma, rect: el.getBoundingClientRect() });
                  } : undefined}
                />
              </p>
              {showPt && seg.translation && (
                <p className="line-trans mx-auto mt-2 max-w-xl text-balance text-[1.0625rem] text-muted">{seg.translation}</p>
              )}
            </>
          ) : (
            <p className="text-sm text-faint">{blobUrl ? "Dê play para ouvir" : loadErr ? "" : "Baixando o áudio…"}</p>
          )}
        </div>
        {loadErr && (
          <p className="mt-4 flex items-center justify-center gap-2 text-center text-[0.8125rem] text-again">
            <WifiOff size={14} /> Não deu para baixar o áudio ({loadErr}).
          </p>
        )}
      </div>

      <div className="pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-2xl px-5">
          {blobUrl && (
            <audio
              ref={audioRef}
              src={blobUrl}
              onTimeUpdate={onTime}
              onPlay={() => { setPlaying(true); lastT.current = null; }}
              onPause={() => { setPlaying(false); flush(); }}
              onEnded={() => { setPlaying(false); flush(); }}
              onLoadedMetadata={(e) => { e.currentTarget.playbackRate = rate; }}
              preload="auto"
            />
          )}
          <div className="flex items-center gap-3">
            <span className="timecode w-10 shrink-0 text-right">{fmtClock(ms)}</span>
            <div
              role="slider"
              tabIndex={0}
              aria-label="Progresso"
              aria-valuemin={0}
              aria-valuemax={Math.round(total / 1000)}
              aria-valuenow={Math.round(ms / 1000)}
              className="relative h-6 flex-1 cursor-pointer touch-none"
              onPointerDown={(e) => {
                const a = audioRef.current;
                if (!a || !total) return;
                const r = e.currentTarget.getBoundingClientRect();
                a.currentTime = (Math.min(Math.max(0, (e.clientX - r.left) / r.width), 1) * total) / 1000;
              }}
            >
              <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-surface-3">
                <div className="absolute inset-y-0 left-0 bg-brand" style={{ width: `${pct}%` }} />
              </div>
            </div>
            <span className="timecode w-10 shrink-0 text-faint">{fmtClock(total)}</span>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <button
              onClick={() => setShowPt((v) => !v)}
              className={cn("h-9 rounded-lg px-2.5 text-[0.8125rem] font-medium transition-colors hover:bg-surface-2", showPt ? "text-brand" : "text-muted")}
              aria-pressed={showPt}
            >
              PT
            </button>
            <div className="flex items-center gap-1">
              <button onClick={() => jumpSeg(-1)} className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" aria-label="Fala anterior (←)">
                <SkipBack size={17} />
              </button>
              <button
                onClick={toggle}
                disabled={!blobUrl}
                className="mx-1 grid h-12 w-12 place-items-center rounded-full bg-brand text-brand-fg transition-colors hover:bg-brand-strong disabled:opacity-40"
                aria-label={playing ? "Pausar" : "Ouvir"}
              >
                {playing ? <Pause size={20} /> : <Play size={20} className="translate-x-[1px]" />}
              </button>
              <button onClick={() => jumpSeg(1)} className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" aria-label="Próxima fala (→)">
                <SkipForward size={17} />
              </button>
            </div>
            <button
              onClick={() => {
                const next = RATES.find((r) => r > rate + 1e-6) ?? RATES[0];
                setRate(next);
                if (audioRef.current) audioRef.current.playbackRate = next;
              }}
              className="timecode h-9 rounded-lg px-2.5 font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              title="Velocidade"
            >
              {rate.toFixed(2).replace(/\.?0+$/, "")}×
            </button>
          </div>
        </div>
      </div>

      {lookup && (
        <WordPopover dose={dose} lemma={lookup.lemma} anchor={lookup.rect} assetUrl={assetUrl} onClose={() => setLookup(null)} />
      )}
    </div>
  );
}
