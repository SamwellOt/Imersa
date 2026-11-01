// Controles da tela de Ajustes: interruptor, stepper e campos que só gravam no
// blur/Enter (passos de aprendizado, número, parâmetros do FSRS).
import { useEffect, useState } from "react";
import { parseSteps, sanitizeW, FSRS_PARAM_COUNT } from "@/lib/srs";
import { cn } from "@/lib/utils";

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-label={label}
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

export function Stepper({ value, min, max, step = 1, onChange, suffix }: {
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
export function CommitField({
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

export function StepsField({ value, onCommit }: { value: string; onCommit: (steps: string[]) => void }) {
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

export function NumberField({ value, min, max, onCommit }: { value: number; min: number; max: number; onCommit: (v: number) => void }) {
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
export function ParamsField({ value, onCommit }: { value: string; onCommit: (w: number[] | null) => void }) {
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

/** Aviso de falha para o `notify` dos Ajustes ("Não deu para reagendar: …"). */
export function failMsg(what: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Não deu para ${what}: ${msg.length > 120 ? msg.slice(0, 120) + "…" : msg}`;
}
