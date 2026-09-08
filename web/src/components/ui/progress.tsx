import { cn } from "@/lib/utils";

export function ProgressBar({
  value,
  max = 100,
  className,
  tone = "brand",
}: {
  value: number;
  max?: number;
  className?: string;
  tone?: "brand" | "good" | "accent";
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const bg = tone === "good" ? "bg-good" : tone === "accent" ? "bg-accent" : "bg-brand";
  return (
    <div
      className={cn("h-1 w-full overflow-hidden rounded-full bg-surface-3", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-500 ease-out", bg)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
