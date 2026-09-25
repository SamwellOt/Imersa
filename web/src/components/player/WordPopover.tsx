import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Plus, Volume2, X, Undo2 } from "lucide-react";
import type { Dose, SentenceCard } from "@/types/dose";
import { db } from "@/lib/db";
import { lemmaInfo, WORD_PREFIX } from "@/lib/cards";
import { addExtraCard, markKnown, unmarkKnown } from "@/lib/srs";
import { playFile } from "@/lib/audioEngine";
import { cn } from "@/lib/utils";

const WIDTH = 288; // 18rem
const GAP = 10;

/**
 * Dicionário da dose, aberto ao tocar numa palavra da legenda: grafia, leitura,
 * significado e o que o aluno já tem dela. Daqui a palavra vira card ("+ card",
 * fora do teto diário) ou é marcada «já sei».
 */
export function WordPopover({
  dose, lemma, anchor, assetUrl, onClose,
}: {
  dose: Dose;
  lemma: string;
  anchor: DOMRect;
  /** Caminho relativo da pasta da dose → URL. */
  assetUrl: (rel: string) => string;
  onClose: () => void;
}) {
  const info = lemmaInfo(dose, lemma);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const cardId = WORD_PREFIX + lemma;
  // o registro desta palavra em QUALQUER lição do idioma (um card por palavra)
  const rec = useLiveQuery(
    async () => (await db.cards.where("language").equals(dose.language).toArray()).find((r) => r.cardId === cardId) ?? null,
    [dose.language, cardId],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - WIDTH / 2), vw - WIDTH - 8);
    const above = anchor.top - h - GAP;
    const top = above >= 8 ? above : Math.min(anchor.bottom + GAP, window.innerHeight - h - 8);
    setPos({ left, top });
  }, [anchor, rec, info?.lemma]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    // no próximo tique: o toque que abriu não pode fechar
    const t = setTimeout(() => document.addEventListener("pointerdown", onDown), 0);
    window.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  if (!info) return null;
  const audio = info.addable?.audioClipSrc ?? info.doseCard?.audioClipSrc;
  // card mínimo para marcar «já sei» uma palavra que não tem material de card aqui
  const asCard: SentenceCard = info.addable ?? info.doseCard ?? {
    id: cardId, segmentId: "", target: info.target, translation: info.meaning ?? "", startMs: 0, endMs: 0,
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  let status: string;
  if (rec?.known) status = "Você marcou «já sei»";
  else if (rec) status = rec.state === 2 ? "Fixada no SRS" : "Em aprendizado no SRS";
  else if (info.base) status = "Da sua base (já conhecida)";
  else if (info.dict) status = "Palavra de apoio (não vira card)";
  else if (info.doseCard) status = "Card desta lição";
  else if (info.cardIn) status = `Card da lição ${Number(info.cardIn.split("-").pop())}`;
  else status = "Nova";

  const canAdd = !rec && !!info.addable;
  const canKnow = !rec && !info.base && !info.dict;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Dicionário: ${info.target}`}
      className="elev-2 fixed z-[70] rounded-xl border border-line bg-surface p-4 text-left text-fg"
      style={{ width: WIDTH, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-target-display text-[1.75rem] leading-tight">{info.target}</p>
          {info.reading && <p className="text-[0.8125rem] text-faint">{info.reading}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {audio && (
            <button
              onClick={() => playFile(assetUrl(audio))}
              className="grid h-8 w-8 place-items-center rounded-full bg-brand-soft text-brand transition-colors hover:bg-brand hover:text-brand-fg"
              aria-label="Ouvir a palavra"
            >
              <Volume2 size={15} />
            </button>
          )}
          <button
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label="Fechar"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {info.meaning ? (
        <p className="line-trans mt-2 text-[1.0625rem] leading-snug text-muted">{info.meaning}</p>
      ) : info.meaningEn ? (
        <p className="mt-2 text-[0.875rem] leading-snug text-muted">
          <span className="mr-1.5 rounded border border-line px-1 text-[0.625rem] font-semibold tracking-wide text-faint">EN</span>
          {info.meaningEn}
        </p>
      ) : (
        <p className="mt-2 text-[0.875rem] text-faint">Sem significado no dicionário desta lição.</p>
      )}

      <p className="mt-3 flex items-baseline justify-between gap-2 text-[0.75rem] text-faint">
        <span>{status}</span>
        {info.freqRank ? <span className="timecode">#{info.freqRank} em frequência</span> : null}
      </p>

      {(canAdd || canKnow || rec?.known) && (
        <div className="mt-3 flex gap-2 border-t border-line pt-3">
          {canAdd && (
            <button
              disabled={busy}
              onClick={() => run(() => addExtraCard(dose, info.addable!))}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand text-[0.8125rem] font-semibold text-brand-fg transition-colors hover:bg-brand-strong disabled:opacity-50"
              title="Vira card agora e aparece na próxima revisão (não gasta a cota do dia)"
            >
              <Plus size={14} /> Card
            </button>
          )}
          {canKnow && (
            <button
              disabled={busy}
              onClick={() => run(() => markKnown(dose, asCard))}
              className={cn(
                "inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line text-[0.8125rem] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50",
              )}
              title="Já conheço: não vira card e conta como sabida"
            >
              <Check size={14} /> Já sei
            </button>
          )}
          {rec?.known && (
            <button
              disabled={busy}
              onClick={() => run(() => unmarkKnown(rec))}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-line text-[0.8125rem] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50"
            >
              <Undo2 size={14} /> Voltar a estudar
            </button>
          )}
        </div>
      )}
    </div>
  );
}
