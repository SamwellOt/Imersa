import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// ---------------- Button ----------------

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

// Preenchimento sólido — sem gradiente e sem glow colorido. A hierarquia entre
// primário e secundário vem do contraste, não do brilho.
const variantCls: Record<Variant, string> = {
  // desabilitado vira superfície neutra: em teal a 40% parecia um botão vivo
  primary: "bg-brand text-brand-fg hover:bg-brand-strong active:bg-brand-strong disabled:bg-surface-3 disabled:text-faint disabled:opacity-100",
  secondary: "bg-surface-2 text-fg border border-line hover:bg-surface-3 hover:border-line-strong",
  ghost: "text-muted hover:text-fg hover:bg-surface-2",
  outline: "border border-line-strong text-fg hover:bg-surface-2",
  danger: "bg-transparent text-again border border-again/35 hover:bg-again/10",
};

const sizeCls: Record<Size, string> = {
  sm: "h-8 px-3 text-[0.8125rem] rounded-lg gap-1.5",
  md: "h-10 px-4 text-sm rounded-lg gap-2",
  lg: "h-11 px-5 text-[0.9375rem] rounded-xl gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", block, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "no-tap-highlight inline-flex select-none items-center justify-center font-semibold transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40",
        variantCls[variant],
        sizeCls[size],
        block && "w-full",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, className, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "no-tap-highlight grid h-9 w-9 place-items-center rounded-lg transition-colors",
        active ? "bg-brand/12 text-brand" : "text-muted hover:bg-surface-2 hover:text-fg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

// ---------------- Card ----------------

export function Card({
  className,
  children,
  interactive,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        // Superfície sólida + 1px de borda. Sem blur, sem sombra colorida.
        "elev-1 rounded-2xl border border-line bg-surface",
        interactive &&
          "cursor-pointer transition-colors hover:border-line-strong hover:bg-surface-2",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

// ---------------- Divider ----------------

export function Divider({ className }: { className?: string }) {
  return <div className={cn("h-px w-full bg-line", className)} />;
}

// ---------------- Section heading ----------------

/** Rótulo de seção — caixa alta, pequeno, com um filete até a margem. */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="label-eyebrow text-faint">{children}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

// ---------------- Setting row ----------------

/** Linha de ajuste: título + descrição à esquerda, controle à direita. */
export function SettingRow({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-xs leading-relaxed text-muted">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ---------------- Kbd ----------------

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-[1.15rem] min-w-[1.15rem] place-items-center rounded border border-line-strong bg-surface-2 px-1 font-sans text-[0.65rem] font-semibold text-faint">
      {children}
    </kbd>
  );
}
