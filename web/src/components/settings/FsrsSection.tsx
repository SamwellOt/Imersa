import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApp } from "@/lib/store";
import {
  countReviews, rescheduleAll, MIN_REVIEWS_TO_OPTIMIZE, FSRS_PARAM_COUNT, type SrsSettings,
} from "@/lib/srs";
import { Card, Button, Divider, SectionLabel } from "@/components/ui/primitives";
import { cn, pluralize } from "@/lib/utils";
import { ParamsField, failMsg } from "./controls";

/** Ajustes → Parâmetros do FSRS: o "Otimizar" do Anki, reagendar e edição à mão. */
export function FsrsSection({
  srs, saveSrs, notify,
}: {
  srs: SrsSettings | null;
  saveSrs: (patch: Partial<SrsSettings>) => void;
  notify: (msg: string) => void;
}) {
  const app = useApp();
  const [reviewsTotal, setReviewsTotal] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!app.activeLanguage) return;
    countReviews(app.activeLanguage).then(setReviewsTotal);
  }, [app.activeLanguage]);

  /** Recalcula todos os cards do idioma repetindo o histórico (Anki: "reagendar"). */
  const reschedule = async () => {
    if (!app.activeLanguage || busy) return;
    setBusy(true);
    try {
      const { changed, total } = await rescheduleAll(app.activeLanguage, srs ?? undefined);
      notify(`${changed} de ${total} ${pluralize(total, "card reagendado", "cards reagendados")}.`);
    } catch (e) {
      notify(failMsg("reagendar", e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-9">
      <SectionLabel>Parâmetros do FSRS</SectionLabel>
      <Card className="mt-3 px-5">
        <div className="py-3.5">
          <div className="text-sm font-medium">
            {srs?.w
              ? `Otimizados${srs.wOptimizedAt ? ` em ${new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).format(srs.wOptimizedAt)}` : ""}${srs.wReviews ? ` · ${srs.wReviews} revisões` : ""}`
              : "Padrão do FSRS-6"}
          </div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted">
            O otimizador ajusta os {FSRS_PARAM_COUNT} parâmetros à sua memória a partir do histórico de notas — o mesmo motor do Anki.
            {reviewsTotal < MIN_REVIEWS_TO_OPTIMIZE
              ? ` Precisa de pelo menos ${MIN_REVIEWS_TO_OPTIMIZE} revisões; você tem ${reviewsTotal}. Até lá, os padrões são a melhor estimativa.`
              : ` Você tem ${reviewsTotal} revisões — vale rodar de novo a cada mês.`}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={reviewsTotal < MIN_REVIEWS_TO_OPTIMIZE || !app.activeLanguage}
              onClick={() => {
                window.location.href = `/otimizar?lang=${encodeURIComponent(app.activeLanguage ?? "")}`;
              }}
            >
              Otimizar parâmetros
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={reschedule}>
              <RefreshCw size={14} className={cn(busy && "animate-spin")} /> Reagendar cards
            </Button>
            {srs?.w && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => saveSrs({ w: null, wOptimizedAt: null, wReviews: 0 })}
              >
                Voltar ao padrão
              </Button>
            )}
          </div>
          <p className="mt-2 text-[0.6875rem] leading-relaxed text-faint">
            "Reagendar" recalcula o estado de cada card repetindo o histórico com os ajustes atuais (parâmetros, retenção alvo, passos). Os intervalos podem encurtar ou esticar de uma vez.
          </p>
        </div>
        <Divider />
        <details className="py-3.5">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">Editar parâmetros à mão</summary>
          <ParamsField
            value={srs?.w ? srs.w.map((n) => +n.toFixed(4)).join(", ") : ""}
            onCommit={(w) => saveSrs({ w, wOptimizedAt: w ? Date.now() : null, wReviews: 0 })}
          />
        </details>
      </Card>
    </div>
  );
}
