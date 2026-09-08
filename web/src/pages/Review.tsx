import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useDocumentTitle } from "@/lib/hooks";
import { useApp } from "@/lib/store";
import { BRAND } from "@/lib/brand";
import { ReviewSession } from "@/components/srs/ReviewSession";
import { EmptyState } from "@/components/ui/feedback";

export function Review() {
  useDocumentTitle("Revisão · " + BRAND.name);
  const nav = useNavigate();
  const lang = useApp((s) => s.activeLanguage);

  if (!lang) {
    return (
      <div className="mx-auto max-w-lg px-5 pt-12">
        <EmptyState title="Escolha um idioma primeiro" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <div className="frosted pt-safe sticky top-0 z-30 border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-2.5">
          <button
            onClick={() => nav("/")}
            className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg"
            aria-label="Sair da revisão"
          >
            <X size={16} />
          </button>
          <div className="text-[0.8125rem] font-medium">Revisão diária</div>
          <div className="w-8" />
        </div>
      </div>
      <div className="mx-auto max-w-3xl px-5 py-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <ReviewSession language={lang} />
      </div>
    </div>
  );
}
