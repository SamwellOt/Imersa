import { cn } from "@/lib/utils";

const BAR_COUNT = 72;
// Alturas determinísticas: uma "onda" estável, não uma animação aleatória.
const BARS = Array.from({ length: BAR_COUNT }, (_, i) => {
  const a = Math.sin(i * 0.55) * 0.5 + Math.sin(i * 0.17 + 1.3) * 0.3 + Math.sin(i * 1.9) * 0.2;
  return 0.22 + Math.abs(a) * 0.78;
});

/** Palco do áudio: forma de onda estática que se colore conforme o progresso. */
export function AudioStage({ pct }: { pct: number }) {
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
