import { cn } from "@/lib/utils";

export interface SegOption<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

/**
 * Controle segmentado. Sem framer-motion de propósito: o indicador era um
 * `motion.span` com `layoutId`, e um elemento com `layoutId` dentro da subárvore
 * que o `AnimatePresence mode="wait"` do DosePlayer anima na saída fazia a saída
 * nunca "completar" — depois de qualquer clique no seletor de legendas, trocar de
 * fase deixava a tela vazia (imersão em opacidade 0, revisão nunca montava).
 * O indicador agora é CSS puro: uma superfície elevada neutra no botão ativo.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border border-line bg-surface-2 p-0.5",
        className,
      )}
      role="tablist"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "no-tap-highlight relative inline-flex items-center gap-1.5 rounded-md border font-medium transition-colors",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-[0.8125rem]",
              active
                ? "elev-1 border-line-strong bg-surface text-fg"
                : "border-transparent text-muted hover:text-fg",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
