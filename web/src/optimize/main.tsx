// /otimizar — página ISOLADA (COOP/COEP) para rodar o otimizador do FSRS.
//
// Por que uma página à parte: o otimizador (fsrs-browser) usa threads WASM, que
// exigem SharedArrayBuffer e portanto uma página "cross-origin isolated". Ligar
// esses cabeçalhos no app inteiro é risco à toa; aqui é só nesta rota (ver
// server/index.mjs e vite.config.ts). O banco (IndexedDB) é o mesmo — mesma origem.
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, Check } from "lucide-react";
import { getProgress } from "fsrs-browser";
import { db, setSetting } from "@/lib/db";
import {
  getSrsSettings, rescheduleAll, FSRS_DEFAULT_W, FSRS_PARAM_COUNT, MIN_REVIEWS_TO_OPTIMIZE,
  type SrsSettings,
} from "@/lib/srs";
import { buildTrainInput, type TrainInput } from "@/lib/fsrsTrain";
import { applyTheme, useApp } from "@/lib/store";
import { Button, Card } from "@/components/ui/primitives";
import { ProgressBar } from "@/components/ui/progress";
import { pluralize, cn } from "@/lib/utils";
import type { TrainMessage } from "./train.worker";
import "../index.css";

applyTheme(useApp.getState().theme);

type Phase =
  | { k: "loading" }
  | { k: "ready"; input: TrainInput }
  | { k: "training"; input: TrainInput; done: number; total: number }
  | { k: "result"; input: TrainInput; w: number[] }
  | { k: "applied"; changed: number; total: number }
  | { k: "error"; message: string };

const PARAM_NAMES = [
  "S0 De novo", "S0 Difícil", "S0 Bom", "S0 Fácil", "D0", "D por nota", "D reversão", "D média",
  "S⁺ base", "S⁺ decaimento", "S⁺ retenção", "S após lapso", "S lapso · D", "S lapso · S", "S lapso · R",
  "Difícil ×", "Fácil ×", "S curto prazo", "S curto prazo · nota", "S curto prazo · passo", "curva (decay)",
];

function OptimizePage() {
  const lang = useMemo(() => new URLSearchParams(location.search).get("lang") ?? "", []);
  const [settings, setSettings] = useState<SrsSettings | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "loading" });

  useEffect(() => {
    (async () => {
      if (!crossOriginIsolated) {
        setPhase({
          k: "error",
          message:
            "Esta página precisa dos cabeçalhos COOP/COEP (isolamento de origem) para rodar o otimizador. Em produção o servidor do Imersa já os envia em /otimizar; confira se você abriu por ele.",
        });
        return;
      }
      if (!lang) {
        setPhase({ k: "error", message: "Idioma não informado (?lang=ko)." });
        return;
      }
      const s = await getSrsSettings();
      setSettings(s);
      const logs = await db.reviewLog.where("language").equals(lang).toArray();
      setPhase({ k: "ready", input: buildTrainInput(logs) });
    })();
  }, [lang]);

  const train = () => {
    if (phase.k !== "ready" && phase.k !== "result") return;
    const input = phase.input;
    setPhase({ k: "training", input, done: 0, total: 0 });
    const worker = new Worker(new URL("./train.worker.ts", import.meta.url), { type: "module" });
    let poll: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    worker.onmessage = (e: MessageEvent<TrainMessage>) => {
      const m = e.data;
      if (m.type === "progress-handle") {
        poll = setInterval(() => {
          try {
            const p = getProgress(m.memory.buffer, m.pointer);
            setPhase((cur) =>
              cur.k === "training" ? { ...cur, done: p.itemsProcessed, total: p.itemsTotal } : cur,
            );
          } catch {
            /* memória ainda não pronta */
          }
        }, 150);
      } else if (m.type === "done") {
        stopPoll();
        worker.terminate();
        setPhase({ k: "result", input, w: m.w });
      } else {
        stopPoll();
        worker.terminate();
        setPhase({ k: "error", message: m.error });
      }
    };
    worker.onerror = (ev) => {
      stopPoll();
      worker.terminate();
      setPhase({ k: "error", message: ev.message || "Falha ao iniciar o worker de treino." });
    };
    worker.postMessage({
      cids: input.cids, eases: input.eases, ids: input.ids, types: input.types,
      minuteOffset: input.minuteOffset,
      relearningSteps: settings?.relearningSteps.length ?? 1,
    });
  };

  const apply = async (reschedule: boolean) => {
    if (phase.k !== "result" || !settings) return;
    const next: SrsSettings = {
      ...settings, w: phase.w, wOptimizedAt: Date.now(), wReviews: phase.input.reviews,
    };
    await setSetting("srs", next);
    setSettings(next);
    const r = reschedule ? await rescheduleAll(lang, next) : { changed: 0, total: 0 };
    setPhase({ k: "applied", ...r });
  };

  const current = settings?.w ?? [...FSRS_DEFAULT_W];

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 py-8">
      <a href="/settings" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg">
        <ArrowLeft size={15} /> Ajustes
      </a>
      <h1 className="font-display mt-5 text-[1.75rem] leading-tight md:text-[2rem]">Otimizar parâmetros do FSRS</h1>
      <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-muted">
        O otimizador ajusta os {FSRS_PARAM_COUNT} parâmetros do FSRS-6 ao seu histórico de notas — o mesmo
        motor que o Anki usa. Quanto mais revisões, melhor o ajuste; abaixo de {MIN_REVIEWS_TO_OPTIMIZE} o padrão
        costuma ser melhor que o resultado.
      </p>

      {phase.k === "loading" && <Card className="mt-6 h-32 animate-pulse" />}

      {phase.k === "error" && (
        <Card className="mt-6 px-5 py-5">
          <p className="text-sm text-again">{phase.message}</p>
        </Card>
      )}

      {(phase.k === "ready" || phase.k === "training" || phase.k === "result") && (
        <Card className="mt-6 px-5 py-5">
          <dl className="grid grid-cols-3 gap-4 text-center">
            <Stat n={phase.input.reviews} label={pluralize(phase.input.reviews, "revisão", "revisões")} />
            <Stat n={phase.input.cards} label="cards" />
            <Stat n={current === settings?.w ? "sim" : "não"} label="já otimizado" />
          </dl>
          {phase.k === "ready" && (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-5">
              <Button onClick={train} disabled={phase.input.reviews < 20}>Otimizar</Button>
              {phase.input.reviews < MIN_REVIEWS_TO_OPTIMIZE && (
                <span className="text-xs leading-relaxed text-faint">
                  Faltam {MIN_REVIEWS_TO_OPTIMIZE - phase.input.reviews} revisões para o piso recomendado — dá para rodar, mas confie pouco no resultado.
                </span>
              )}
            </div>
          )}
          {phase.k === "training" && (
            <div className="mt-5 border-t border-line pt-5">
              <div className="flex items-baseline justify-between text-xs text-muted">
                <span>Treinando…</span>
                <span className="tabular-nums">
                  {phase.total ? `${Math.round((phase.done / phase.total) * 100)}%` : "preparando"}
                </span>
              </div>
              <ProgressBar className="mt-2" value={phase.done} max={Math.max(1, phase.total)} />
              <p className="mt-2 text-[0.6875rem] text-faint">Leva de segundos a um minuto, conforme o tamanho do histórico.</p>
            </div>
          )}
          {phase.k === "result" && (
            <div className="mt-5 border-t border-line pt-5">
              <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 gap-y-1 text-[0.75rem] tabular-nums">
                <span className="text-faint">parâmetro</span>
                <span className="text-right text-faint">atual</span>
                <span className="text-right text-faint">novo</span>
                {phase.w.map((v, i) => (
                  <Row key={i} name={PARAM_NAMES[i] ?? `w${i}`} a={current[i]} b={v} />
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button onClick={() => apply(true)}>
                  <Check size={15} /> Aplicar e reagendar
                </Button>
                <Button variant="secondary" onClick={() => apply(false)}>Só aplicar</Button>
                <Button variant="ghost" onClick={train}>Rodar de novo</Button>
              </div>
              <p className="mt-2 text-[0.6875rem] leading-relaxed text-faint">
                "Reagendar" recalcula cada card repetindo o histórico com os novos parâmetros (como o "reagendar cards ao mudar" do Anki).
              </p>
            </div>
          )}
        </Card>
      )}

      {phase.k === "applied" && (
        <Card className="mt-6 px-5 py-5">
          <div className="flex items-center gap-2 text-good">
            <Check size={15} />
            <p className="label-eyebrow">Parâmetros aplicados</p>
          </div>
          <p className="mt-2 text-sm text-muted">
            {phase.total
              ? `${phase.changed} de ${phase.total} ${pluralize(phase.total, "card reagendado", "cards reagendados")}.`
              : "Os próximos agendamentos já usam os novos parâmetros."}{" "}
            Com a sincronização ligada, os outros aparelhos recebem os mesmos parâmetros.
          </p>
          <Button className="mt-4" onClick={() => (location.href = "/settings")}>Voltar aos Ajustes</Button>
        </Card>
      )}
    </div>
  );
}

function Stat({ n, label }: { n: number | string; label: string }) {
  return (
    <div>
      <dd className="text-lg font-semibold tabular-nums">{n}</dd>
      <dt className="mt-0.5 text-[0.6875rem] text-faint">{label}</dt>
    </div>
  );
}

function Row({ name, a, b }: { name: string; a: number | undefined; b: number }) {
  const changed = a == null || Math.abs(a - b) > 1e-4;
  return (
    <>
      <span className="truncate text-muted">{name}</span>
      <span className="text-right text-faint">{a == null ? "—" : a.toFixed(4)}</span>
      <span className={cn("text-right", changed ? "text-fg" : "text-faint")}>{b.toFixed(4)}</span>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OptimizePage />
  </StrictMode>,
);
