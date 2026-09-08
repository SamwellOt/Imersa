// Worker de treino: roda o otimizador do FSRS (fsrs-browser, WASM + threads)
// fora da thread da página. A página só recebe progresso e o resultado.
import init, { Fsrs, initThreadPool, Progress } from "fsrs-browser";

export interface TrainRequest {
  cids: BigInt64Array;
  eases: Uint8Array;
  ids: BigInt64Array;
  types: Uint8Array;
  minuteOffset: number;
  relearningSteps: number;
}

export type TrainMessage =
  | { type: "progress-handle"; memory: WebAssembly.Memory; pointer: number }
  | { type: "done"; w: number[] }
  | { type: "error"; error: string };

self.onmessage = async (e: MessageEvent<TrainRequest>) => {
  const post = (m: TrainMessage) => (self as unknown as Worker).postMessage(m);
  try {
    const out = await init();
    const threads = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 8));
    await initThreadPool(threads);
    const progress = Progress.new();
    // a memória é compartilhada: a página lê o progresso direto dela enquanto
    // esta thread fica bloqueada no treino
    post({ type: "progress-handle", memory: out.memory, pointer: progress.pointer() });
    const req = e.data;
    const fsrs = new Fsrs();
    const w = fsrs.computeParametersAnki(
      req.minuteOffset,
      req.cids,
      req.eases,
      req.ids,
      req.types,
      progress,
      true, // enable_short_term (usamos passos de aprendizado)
      req.relearningSteps,
      undefined,
    );
    post({ type: "done", w: Array.from(w) });
  } catch (err) {
    post({ type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
