import { useEffect, useRef, useState } from "react";
import { Download, Upload, Moon, Sun, Smartphone, RefreshCw } from "lucide-react";
import { useDocumentTitle } from "@/lib/hooks";
import { useApp, type SubtitleMode } from "@/lib/store";
import {
  getSrsSettings, DEFAULT_SRS_SETTINGS, parseSteps, stepsToText, sanitizeW, rescheduleAll,
  MIN_REVIEWS_TO_OPTIMIZE, FSRS_PARAM_COUNT,
  type SrsSettings, type ReviewOrder, type NewOrder,
} from "@/lib/srs";
import { db, setSetting, exportAll, importAll, resetAll, resetLanguage, type ExportBundle } from "@/lib/db";
import { Card, Button, Divider, SectionLabel, SettingRow as Row } from "@/components/ui/primitives";
import { AccountSection } from "@/components/settings/AccountSection";
import { Segmented } from "@/components/ui/Segmented";
import { cn, pluralize } from "@/lib/utils";
import { BRAND } from "@/lib/brand";

/**
 * Instalação do PWA. O Chrome/Edge guardam o evento `beforeinstallprompt` e só
 * oferecem "instalar" num menu escondido — aqui a oferta fica visível, e some
 * quando o app já está rodando instalado.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function useInstallPrompt() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia("(display-mode: standalone)").matches,
  );
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };
  return { canInstall: !!deferred, installed, install };
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-6 w-10 rounded-full border transition-colors",
        checked ? "border-brand bg-brand" : "border-line bg-surface-3",
      )}
    >
      <span
        className={cn(
          "absolute left-[0.15rem] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white transition-transform",
          checked && "translate-x-[1.25rem]",
        )}
      />
    </button>
  );
}

function Stepper({ value, min, max, step = 1, onChange, suffix }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string;
}) {
  const btn =
    "grid h-8 w-8 place-items-center text-base text-muted transition-colors hover:bg-surface-3 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex items-center overflow-hidden rounded-lg border border-line bg-surface-2">
      <button
        onClick={() => onChange(Math.max(min, +(value - step).toFixed(2)))}
        disabled={value <= min}
        className={btn}
        aria-label="Diminuir"
      >
        −
      </button>
      <span className="w-14 border-x border-line py-1 text-center text-sm font-semibold tabular-nums">
        {value}
        {suffix && <span className="text-xs font-normal text-muted">{suffix}</span>}
      </span>
      <button
        onClick={() => onChange(Math.min(max, +(value + step).toFixed(2)))}
        disabled={value >= max}
        className={btn}
        aria-label="Aumentar"
      >
        +
      </button>
    </div>
  );
}

/** Campo de texto que só grava no blur/Enter e mostra quando o valor não vale. */
function CommitField({
  value, onCommit, validate, placeholder, className, mono = true,
}: {
  value: string;
  onCommit: (v: string) => boolean;
  validate: (v: string) => boolean;
  placeholder?: string;
  className?: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setDraft(value);
    setBad(false);
  }, [value]);
  const commit = () => {
    if (draft.trim() === value.trim()) return;
    if (!validate(draft)) {
      setBad(true);
      return;
    }
    setBad(!onCommit(draft));
  };
  return (
    <input
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        setBad(false);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      spellCheck={false}
      autoComplete="off"
      placeholder={placeholder}
      aria-invalid={bad}
      className={cn(
        "rounded-md border bg-bg px-2.5 py-1.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent",
        mono && "font-mono",
        bad ? "border-again" : "border-line",
        className,
      )}
    />
  );
}

function StepsField({ value, onCommit }: { value: string; onCommit: (steps: string[]) => void }) {
  return (
    <CommitField
      value={value}
      validate={(v) => parseSteps(v) != null}
      onCommit={(v) => {
        const steps = parseSteps(v);
        if (!steps) return false;
        onCommit(steps);
        return true;
      }}
      placeholder="1m 10m"
      className="w-28 text-center"
    />
  );
}

function NumberField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }) {
  return (
    <CommitField
      value={String(value)}
      validate={(v) => Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max}
      onCommit={(v) => {
        onCommit(Number(v));
        return true;
      }}
      className="w-24 text-center tabular-nums"
    />
  );
}

/** Lista de parâmetros separada por vírgula (17, 19 ou 21 números); vazio = padrão. */
function ParamsField({ value, onCommit }: { value: string; onCommit: (w: number[] | null) => void }) {
  const parse = (v: string) => {
    const t = v.trim();
    if (!t) return null;
    return sanitizeW(t.split(/[\s,]+/).filter(Boolean).map(Number));
  };
  return (
    <div className="mt-3">
      <CommitField
        value={value}
        validate={(v) => !v.trim() || parse(v) != null}
        onCommit={(v) => {
          onCommit(parse(v));
          return true;
        }}
        placeholder={`${FSRS_PARAM_COUNT} números separados por vírgula (vazio = padrão)`}
        className="w-full"
      />
      <p className="mt-1.5 text-[0.6875rem] leading-relaxed text-faint">
        Cole aqui parâmetros vindos do Anki ou de outro otimizador FSRS. Depois de trocar, use "Reagendar cards".
      </p>
    </div>
  );
}

// As mesmas cinco opções do player: é o MESMO estado, não um "padrão" à parte.
// Com só três, quem tivesse deixado o player em "PT" via "Ambas" marcado aqui —
// o controle mentia sobre o modo atual e mudava tudo ao primeiro toque.
const SUB_OPTS: { value: SubtitleMode; label: string }[] = [
  { value: "target", label: "Alvo" },
  { value: "translation", label: "PT" },
  { value: "both", label: "Ambas" },
  { value: "primed", label: "Primed" },
  { value: "off", label: "Off" },
];

export function Settings() {
  useDocumentTitle("Ajustes · " + BRAND.name);
  const app = useApp();
  const { canInstall, installed, install } = useInstallPrompt();
  const [srs, setSrs] = useState<SrsSettings | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [reviewsTotal, setReviewsTotal] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getSrsSettings().then(setSrs);
  }, []);
  useEffect(() => {
    if (!app.activeLanguage) return;
    db.reviewLog.where("language").equals(app.activeLanguage).count().then(setReviewsTotal);
  }, [app.activeLanguage]);

  /** Recalcula todos os cards do idioma repetindo o histórico (Anki: "reagendar"). */
  const reschedule = async () => {
    if (!app.activeLanguage || busy) return;
    setBusy(true);
    try {
      const { changed, total } = await rescheduleAll(app.activeLanguage, srs ?? undefined);
      notify(`${changed} de ${total} ${pluralize(total, "card reagendado", "cards reagendados")}.`);
    } finally {
      setBusy(false);
    }
  };

  const saveSrs = async (patch: Partial<SrsSettings>) => {
    // a gravação fica FORA do updater: em StrictMode o updater roda duas vezes
    // e escrevia o ajuste duas vezes no banco (duas mudanças para sincronizar).
    // Ainda carregando? Lê do banco em vez de partir dos padrões — senão um
    // clique cedo gravava `DEFAULT + patch` por cima dos parâmetros otimizados.
    const next = { ...(srs ?? (await getSrsSettings())), ...patch };
    setSrs(next);
    void setSetting("srs", next);
  };

  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  const doExport = async () => {
    const bundle = await exportAll();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `imersa-backup-${new Date().toISOString().slice(0, 10)}.json`;
    // o link precisa estar no documento (Firefox ignora o clique fora dele) e a
    // URL só pode ser revogada depois que o download começou
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 5000);
    notify("Backup exportado.");
  };

  const doImport = async (file: File) => {
    try {
      const bundle = JSON.parse(await file.text()) as ExportBundle;
      await importAll(bundle);
      notify("Backup importado. Recarregando…");
      setTimeout(() => location.reload(), 900);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Falha ao importar.");
    }
  };

  const doReset = async () => {
    if (!confirm("Isso apaga todo o seu progresso (cards, revisões, estatísticas). Continuar?")) return;
    await resetAll();
    notify("Progresso apagado. Recarregando…");
    setTimeout(() => location.reload(), 700);
  };

  const doResetLang = async () => {
    const lang = app.activeLanguage;
    if (!lang) return;
    if (!confirm(`Isso zera o progresso do idioma atual (${lang}). Continuar?`)) return;
    await resetLanguage(lang);
    notify("Idioma reiniciado. Recarregando…");
    setTimeout(() => location.reload(), 700);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="font-display text-[1.75rem] leading-tight md:text-[2rem]">Ajustes</h1>

      {/* Conta — no topo: é quem você é e onde o progresso mora */}
      <AccountSection notify={notify} />

      {/* Aparência */}
      <div className="mt-9">
        <SectionLabel>Aparência</SectionLabel>
        <Card className="mt-3 px-5">
          <Row title="Tema">
            <Segmented
              value={app.theme}
              onChange={app.setTheme}
              options={[
                { value: "dark", label: "Escuro", icon: <Moon size={13} /> },
                { value: "light", label: "Claro", icon: <Sun size={13} /> },
              ]}
              size="sm"
            />
          </Row>
        </Card>
      </div>

      {/* App */}
      {(canInstall || installed) && (
        <div className="mt-9">
          <SectionLabel>Aplicativo</SectionLabel>
          <Card className="mt-3 px-5">
            <Row
              title={installed ? "Instalado" : "Instalar o Imersa"}
              desc={
                installed
                  ? "Rodando como app. O conteúdo já visto funciona offline."
                  : "Abre em janela própria, com ícone. Funciona offline (menos o vídeo)."
              }
            >
              {installed ? (
                <span className="inline-flex items-center gap-1.5 text-sm text-good">
                  <Smartphone size={14} /> Ativo
                </span>
              ) : (
                <Button variant="secondary" size="sm" onClick={install}>
                  <Smartphone size={14} /> Instalar
                </Button>
              )}
            </Row>
          </Card>
        </div>
      )}

      {/* Imersão */}
      <div className="mt-9">
        <SectionLabel>Imersão</SectionLabel>
        <Card className="mt-3 px-5">
          <div className="py-3.5">
            <div className="text-sm font-medium">Legendas</div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted">
              O modo em uso no player — trocar aqui ou lá dá no mesmo
            </div>
            <div className="no-scrollbar mt-3 flex overflow-x-auto">
              <Segmented
                value={app.subtitleMode}
                onChange={app.setSubtitleMode}
                options={SUB_OPTS}
                size="sm"
              />
            </div>
          </div>
          <Divider />
          <Row
            title="Marcar palavras por conhecimento"
            desc="Na legenda, sublinha o que está em aprendizado e pontilha o que você ainda não estudou; o já fixado fica limpo"
          >
            <Toggle checked={app.subtitleMarks} onChange={app.setSubtitleMarks} />
          </Row>
          <Divider />
          <Row title="Furigana / leitura" desc="Mostrar a leitura quando disponível">
            <Toggle checked={app.furigana} onChange={app.setFurigana} />
          </Row>
        </Card>
      </div>

      {/* SRS — os ajustes do Anki que importam, com os mesmos padrões */}
      <div className="mt-9">
        <SectionLabel>Repetição espaçada</SectionLabel>
        <Card className="mt-3 px-5">
          <Row title="Palavras novas por dia" desc="Uma dose = 20 palavras">
            <Stepper value={srs?.newPerDay ?? 20} min={0} max={100} step={5} onChange={(v) => saveSrs({ newPerDay: v })} />
          </Row>
          <Divider />
          <Row title="Máx. revisões por dia" desc="Cards em revisão avaliados hoje; aprendizado não conta">
            <Stepper value={srs?.maxReviewsPerDay ?? 200} min={20} max={999} step={20} onChange={(v) => saveSrs({ maxReviewsPerDay: v })} />
          </Row>
          <Divider />
          <Row title="Retenção alvo" desc="Probabilidade de lembrar na hora de revisar. 90% é o padrão; acima de 95% o volume de revisões dispara">
            <Stepper
              value={srs ? Math.round(srs.requestRetention * 100) : 90}
              min={70}
              max={99}
              step={1}
              suffix="%"
              onChange={(v) => saveSrs({ requestRetention: v / 100 })}
            />
          </Row>
          <Divider />
          <Row title="Passos de aprendizado" desc="Repetições no mesmo dia antes de o card graduar. Padrão do Anki: 1m 10m">
            <StepsField
              value={stepsToText(srs?.learningSteps ?? DEFAULT_SRS_SETTINGS.learningSteps)}
              onCommit={(steps) => saveSrs({ learningSteps: steps })}
            />
          </Row>
          <Divider />
          <Row title="Passos de reaprendizado" desc="Depois de um De novo em card fixado. Padrão: 10m">
            <StepsField
              value={stepsToText(srs?.relearningSteps ?? DEFAULT_SRS_SETTINGS.relearningSteps)}
              onCommit={(steps) => saveSrs({ relearningSteps: steps })}
            />
          </Row>
          <Divider />
          <Row title="Antecipar aprendizado" desc="Sem mais nada na fila, cards em aprendizado que vencem em até tantos minutos entram adiantados">
            <Stepper value={srs?.learnAheadMin ?? 20} min={0} max={120} step={5} suffix=" min" onChange={(v) => saveSrs({ learnAheadMin: v })} />
          </Row>
          <Divider />
          <Row title="Intervalo máximo" desc="Em dias. O padrão do Anki (36500) na prática não limita">
            <NumberField
              value={srs?.maximumInterval ?? 36500}
              min={30}
              max={36500}
              onCommit={(v) => saveSrs({ maximumInterval: v })}
            />
          </Row>
          <Divider />
          <div className="py-3.5">
            <div className="text-sm font-medium">Ordem das revisões</div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted">
              Cards em aprendizado vêm sempre primeiro. "Mais esquecidos" põe na frente os de menor retenção estimada — bom para atrasos
            </div>
            <div className="no-scrollbar mt-3 flex overflow-x-auto">
              <Segmented<ReviewOrder>
                value={srs?.reviewOrder ?? "due"}
                onChange={(v) => saveSrs({ reviewOrder: v })}
                options={[
                  { value: "due", label: "Vencimento" },
                  { value: "retrievability", label: "Mais esquecidos" },
                  { value: "random", label: "Aleatória" },
                ]}
                size="sm"
              />
            </div>
          </div>
          <Divider />
          <div className="py-3.5">
            <div className="text-sm font-medium">Palavras novas</div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted">
              Misturadas entre os vencidos, ou todas antes/depois deles
            </div>
            <div className="no-scrollbar mt-3 flex overflow-x-auto">
              <Segmented<NewOrder>
                value={srs?.newOrder ?? "mix"}
                onChange={(v) => saveSrs({ newOrder: v })}
                options={[
                  { value: "mix", label: "Misturadas" },
                  { value: "before", label: "Antes" },
                  { value: "after", label: "Depois" },
                ]}
                size="sm"
              />
            </div>
          </div>
          <Divider />
          <Row title="Variar os intervalos" desc="Pequeno desvio aleatório para cards da mesma dose não vencerem todos no mesmo dia">
            <Toggle checked={srs?.enableFuzz ?? true} onChange={(v) => saveSrs({ enableFuzz: v })} />
          </Row>
        </Card>
      </div>

      {/* Parâmetros do FSRS — o "Otimizar" do Anki */}
      <div className="mt-9">
        <SectionLabel>Parâmetros do FSRS</SectionLabel>
        <Card className="mt-3 px-5">
          <div className="py-3.5">
            <div className="text-sm font-medium">
              {srs?.w
                ? `Otimizados${srs.wOptimizedAt ? ` em ${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(srs.wOptimizedAt)}` : ""}${srs.wReviews ? ` · ${srs.wReviews} revisões` : ""}`
                : "Padrão do FSRS-6"}
            </div>
            <div className="mt-0.5 text-xs leading-relaxed text-muted">
              O otimizador ajusta os {FSRS_PARAM_COUNT} parâmetros à sua memória a partir do histórico de notas — o mesmo motor do Anki.
              {reviewsTotal < MIN_REVIEWS_TO_OPTIMIZE
                ? ` Precisa de pelo menos ${MIN_REVIEWS_TO_OPTIMIZE} revisões; você tem ${reviewsTotal}. Até lá, os padrões são a melhor estimativa.`
                : ` Você tem ${reviewsTotal} revisões — vale rodar de novo a cada mês.`}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={reviewsTotal < MIN_REVIEWS_TO_OPTIMIZE || !app.activeLanguage}
                onClick={() => {
                  window.location.href = `/otimizar?lang=${encodeURIComponent(app.activeLanguage ?? "")}`;
                }}
              >
                Otimizar parâmetros
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={reschedule}>
                <RefreshCw size={14} className={cn(busy && "animate-spin")} /> Reagendar cards
              </Button>
              {srs?.w && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => saveSrs({ w: null, wOptimizedAt: null, wReviews: 0 })}
                >
                  Voltar ao padrão
                </Button>
              )}
            </div>
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-faint">
              "Reagendar" recalcula o estado de cada card repetindo o histórico com os ajustes atuais (parâmetros, retenção alvo, passos). Os intervalos podem encurtar ou esticar de uma vez.
            </p>
          </div>
          <Divider />
          <details className="py-3.5">
            <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">Editar parâmetros à mão</summary>
            <ParamsField
              value={srs?.w ? srs.w.map((n) => +n.toFixed(4)).join(", ") : ""}
              onCommit={(w) => saveSrs({ w, wOptimizedAt: w ? Date.now() : null, wReviews: 0 })}
            />
          </details>
        </Card>
      </div>

      {/* Dados */}
      <div className="mt-9">
        <SectionLabel>Dados</SectionLabel>
        <Card className="mt-3 px-5">
          <Row title="Exportar progresso" desc="Backup em JSON">
            <Button variant="secondary" size="sm" onClick={doExport}>
              <Download size={14} /> Exportar
            </Button>
          </Row>
          <Divider />
          <Row title="Importar progresso" desc="Restaura a partir de um backup">
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> Importar
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])}
            />
          </Row>
          <Divider />
          <Row title="Reiniciar este idioma" desc="Zera o progresso só do idioma atual">
            <Button variant="secondary" size="sm" onClick={doResetLang}>
              Reiniciar
            </Button>
          </Row>
          <Divider />
          <Row title="Apagar tudo" desc="Remove todo o progresso local, de todos os idiomas">
            <Button variant="danger" size="sm" onClick={doReset}>
              Apagar
            </Button>
          </Row>
        </Card>
        <p className="mt-3 max-w-[62ch] px-1 text-xs leading-relaxed text-faint">
          O {BRAND.name} guarda tudo no seu navegador (IndexedDB) e funciona offline. Com uma
          conta, o mesmo progresso aparece em todos os aparelhos; o backup em arquivo continua
          valendo como cópia de segurança.
        </p>
      </div>

      {flash && (
        <div className="elev-2 fixed inset-x-0 bottom-24 z-50 mx-auto w-fit rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium md:bottom-8">
          {flash}
        </div>
      )}
    </div>
  );
}
