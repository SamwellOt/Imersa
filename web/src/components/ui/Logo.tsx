import { useId } from "react";
import { cn } from "@/lib/utils";
import { BRAND } from "@/lib/brand";

/**
 * Marca da Imersa: um círculo preenchido até a linha d'água — uma "dose" de
 * imersão. Monocromático (herda `currentColor`), legível a 16px, sem gradiente.
 */
export function LogoMark({ className, size = 26 }: { className?: string; size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn("shrink-0 text-brand", className)}
      aria-hidden
    >
      <defs>
        <clipPath id={`imersa-clip-${id}`}>
          <circle cx="12" cy="12" r="9.4" />
        </clipPath>
      </defs>
      <circle cx="12" cy="12" r="9.4" stroke="currentColor" strokeWidth="1.6" opacity="0.34" />
      <g clipPath={`url(#imersa-clip-${id})`}>
        <path
          d="M-2 13.6c2.5 0 2.5-2.3 5-2.3s2.5 2.3 5 2.3 2.5-2.3 5-2.3 2.5 2.3 5 2.3 2.5-2.3 5-2.3V25H-2z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

export function Logo({ className, showWord = true }: { className?: string; showWord?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <LogoMark />
      {showWord && (
        <span className="font-display text-[1.3rem] leading-none text-fg">{BRAND.name}</span>
      )}
    </div>
  );
}
