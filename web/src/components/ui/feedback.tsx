import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-brand",
        className,
      )}
      role="status"
      aria-label="Carregando"
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-lg bg-surface-2", className)}>
      {/* o brilho lê o texto do tema (`fg`), senão ele some no tema claro */}
      <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-fg/[0.06] to-transparent [animation:shimmer_1.6s_infinite]" />
    </div>
  );
}

/**
 * Esqueletos por tela. Um spinner no meio da página apagava a interface inteira
 * a cada navegação; o esqueleto mantém a moldura de pé e só o conteúdo chega
 * depois — a tela não "pisca" nem salta quando os dados entram.
 */
export function HomeSkeleton() {
  return (
    <div className="mx-auto flex max-w-[960px] flex-col gap-6" aria-busy>
      <div>
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="mt-2.5 h-8 w-52" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_236px]">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[22rem] w-full rounded-2xl" />
          <Skeleton className="h-[4.5rem] w-full rounded-xl" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-[11rem] w-full rounded-2xl" />
          <Skeleton className="h-[9rem] w-full rounded-2xl" />
        </div>
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 5, title = true }: { rows?: number; title?: boolean }) {
  return (
    <div className="mx-auto max-w-[960px]" aria-busy>
      {title && (
        <>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="mt-3 h-3.5 w-56" />
        </>
      )}
      <Skeleton className="mt-6 h-9 w-full max-w-[22rem] rounded-lg" />
      <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-4">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="overflow-hidden rounded-xl border border-line">
            <Skeleton className="aspect-video w-full rounded-none" />
            <div className="px-3 py-3">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="mt-2 h-3.5 w-5/6" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function StatsSkeleton() {
  return (
    <div className="mx-auto max-w-[960px]" aria-busy>
      <Skeleton className="h-8 w-44" />
      <Skeleton className="mt-3 h-3.5 w-80" />
      <div className="mt-8 grid gap-10 lg:grid-cols-2 lg:gap-x-10">
        <div className="flex flex-col gap-10">
          <Skeleton className="h-[6rem] w-full rounded-xl" />
          <Skeleton className="h-[17rem] w-full rounded-xl" />
        </div>
        <div className="flex flex-col gap-10">
          <Skeleton className="h-[14rem] w-full rounded-xl" />
          <Skeleton className="h-[11rem] w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

export function LoadingScreen({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="flex items-center gap-2.5 text-muted">
        <Spinner />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-2xl border border-line bg-surface px-6 py-12 text-center">
      <div className="max-w-sm">
        {icon && <div className="mx-auto mb-3 text-faint">{icon}</div>}
        <h3 className="font-display text-lg text-fg">{title}</h3>
        {description && (
          <p className="mx-auto mt-1.5 max-w-[34ch] text-sm leading-relaxed text-muted">
            {description}
          </p>
        )}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorScreen({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="grid min-h-[60vh] place-items-center px-4">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-full border border-again/30 text-lg font-semibold text-again">
          !
        </div>
        <h3 className="font-display text-lg">Algo deu errado</h3>
        <p className="mt-1.5 break-words text-sm leading-relaxed text-muted">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-5 rounded-lg border border-line bg-surface-2 px-3.5 py-2 text-sm font-semibold transition-colors hover:bg-surface-3"
          >
            Tentar de novo
          </button>
        )}
      </div>
    </div>
  );
}
