import { useCallback, useEffect, useRef, useState } from "react";
import { SYNC_EVENT } from "./sync";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  reload: () => void;
}

/** Minimal async loader with cancellation + manual reload. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // Já há dado na tela? A recarga (sync recebido, `reload`) roda por baixo, sem
  // trocar a página inteira pelo esqueleto — antes cada sincronização que trazia
  // algo do outro aparelho fazia o Hoje piscar em esqueleto.
  const hasData = useRef(false);

  // Chegou dado de outro aparelho? Recarrega — senão o celular mostraria o
  // progresso velho até o usuário navegar.
  useEffect(() => {
    const onSynced = (e: Event) => {
      const detail = (e as CustomEvent<{ received?: number }>).detail;
      if (detail?.received) setNonce((n) => n + 1);
    };
    addEventListener(SYNC_EVENT, onSynced);
    return () => removeEventListener(SYNC_EVENT, onSynced);
  }, []);

  // As dependências mudaram (outro idioma, outra dose)? O dado em tela é de
  // OUTRA coisa: volta ao esqueleto em vez de mostrar o coreano enquanto o
  // japonês carrega. Só o `nonce` (recarga por baixo) preserva o que está.
  const depsKey = JSON.stringify(deps);
  const lastDepsKey = useRef(depsKey);
  if (lastDepsKey.current !== depsKey) {
    lastDepsKey.current = depsKey;
    hasData.current = false;
  }

  useEffect(() => {
    let alive = true;
    setLoading(!hasData.current);
    if (!hasData.current) setData(null);
    setError(null);
    fnRef.current()
      .then((res) => {
        if (alive) {
          hasData.current = true;
          setData(res);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(e instanceof Error ? e : new Error(String(e)));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, reload };
}

/** requestAnimationFrame ticker while `active` — used to sync subtitles to media. */
export function useRaf(callback: () => void, active: boolean) {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      cbRef.current();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/** Keydown handler bound to window, cleaned up on unmount. */
export function useHotkeys(handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const fn = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [enabled]);
}

/**
 * O alvo do evento é um controle que já responde ao teclado sozinho?
 * Sem isso, um atalho global (Espaço) engole a ativação do botão focado.
 */
export function isInteractiveTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t?.closest?.(
    'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="slider"], [contenteditable="true"]',
  );
}

/**
 * O foco está num campo de texto? Guarda mais estreita que `isInteractiveTarget`:
 * atalhos como "/" devem funcionar com um botão focado (o botão não usa "/"),
 * mas nunca no meio de uma digitação.
 */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
}

/** Define o <title> da aba — some do histórico saber em que tela você estava. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** `true` enquanto a media query casa (reage a redimensionar). */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
