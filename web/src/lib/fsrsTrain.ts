// Prepara o log de notas no formato de revlog do Anki, que é o que o otimizador
// (fsrs-browser = fsrs-rs, o mesmo motor do Anki) consome:
//   cid  = id do card · ease = nota 1..4 · id = instante (ms) · type = 0 aprendendo,
//   1 revisão, 2 reaprendendo. O `minute_offset` posiciona a virada do dia.
import { State } from "ts-fsrs";
import type { ReviewRecord } from "./db";
import { DAY_ROLLOVER_HOUR } from "./utils";

export interface TrainInput {
  cids: BigInt64Array;
  eases: Uint8Array;
  ids: BigInt64Array;
  types: Uint8Array;
  /** Fuso local menos a hora da virada do dia, em minutos (convenção do fsrs-rs). */
  minuteOffset: number;
  reviews: number;
  cards: number;
}

function revlogType(state: State): number {
  if (state === State.Review) return 1;
  if (state === State.Relearning) return 2;
  return 0; // New / Learning
}

export function buildTrainInput(logs: ReviewRecord[], now = new Date()): TrainInput {
  const sorted = [...logs]
    .filter((r) => r.rating >= 1 && r.rating <= 4)
    .sort((a, b) => a.reviewedAt - b.reviewedAt || a.key.localeCompare(b.key));
  const cardIndex = new Map<string, bigint>();
  const n = sorted.length;
  const cids = new BigInt64Array(n);
  const eases = new Uint8Array(n);
  const ids = new BigInt64Array(n);
  const types = new Uint8Array(n);
  sorted.forEach((r, i) => {
    let cid = cardIndex.get(r.key);
    if (cid == null) cardIndex.set(r.key, (cid = BigInt(cardIndex.size + 1)));
    cids[i] = cid;
    eases[i] = r.rating;
    ids[i] = BigInt(Math.round(r.reviewedAt));
    types[i] = revlogType(r.state);
  });
  // dia local = floor((ms + minuteOffset·60000) / 86400000)
  // JS: getTimezoneOffset() = UTC − local (BRT = +180) → local = −offset.
  const minuteOffset = -now.getTimezoneOffset() - DAY_ROLLOVER_HOUR * 60;
  return { cids, eases, ids, types, minuteOffset, reviews: n, cards: cardIndex.size };
}
