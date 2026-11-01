import { useApp } from "@/lib/store";
import { DEFAULT_SRS_SETTINGS, stepsToText, type SrsSettings, type ReviewOrder, type NewOrder } from "@/lib/srs";
import { Card, Divider, SectionLabel, SettingRow as Row } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { Toggle, Stepper, StepsField, NumberField } from "./controls";

/** Ajustes → Repetição espaçada: os ajustes do Anki que importam, com os mesmos padrões. */
export function SrsSection({ srs, saveSrs }: { srs: SrsSettings | null; saveSrs: (patch: Partial<SrsSettings>) => void }) {
  const app = useApp();
  return (
    <div className="mt-9">
      <SectionLabel>Repetição espaçada</SectionLabel>
      <Card className="mt-3 px-5">
        <Row title="Escrita na frente do card" desc="Mostrar a palavra no idioma estudado junto do áudio, antes de revelar a resposta">
          <Toggle label="Escrita na frente do card" checked={app.flashcardFrontText} onChange={app.setFlashcardFrontText} />
        </Row>
        <Divider />
        <Row
          title="Frase-exemplo na frente do card"
          desc="A frase da lição (a i+1, quando existe) embaixo da palavra, com ela sublinhada. Ao abrir o card só a palavra toca; a frase toca no botão"
        >
          <Toggle label="Frase-exemplo na frente do card" checked={app.flashcardExample} onChange={app.setFlashcardExample} />
        </Row>
        <Divider />
        <Row title="Tocar a frase ao revelar" desc="Ao mostrar a resposta, a frase-exemplo toca sozinha">
          <Toggle label="Tocar a frase ao revelar" checked={app.autoPlayExample} onChange={app.setAutoPlayExample} />
        </Row>
        <Divider />
        <Row
          title="Cards de frase separados"
          desc="Cards só de escuta com a frase i+1 (a frente é o áudio da frase). Desligado, os que já existem saem das filas sem ser apagados"
        >
          <Toggle label="Cards de frase separados" checked={srs?.sentenceCards ?? false} onChange={(v) => saveSrs({ sentenceCards: v })} />
        </Row>
        <Divider />
        <Row title="Palavras novas por dia" desc="Uma dose = 20 palavras">
          <Stepper value={srs?.newPerDay ?? 20} min={0} max={100} step={5} onChange={(v) => saveSrs({ newPerDay: v })} />
        </Row>
        <Divider />
        <Row title="Máx. revisões por dia" desc="Cards em revisão avaliados hoje; aprendizado não conta">
          <Stepper value={srs?.maxReviewsPerDay ?? 200} min={20} max={999} step={20} onChange={(v) => saveSrs({ maxReviewsPerDay: v })} />
        </Row>
        <Divider />
        <Row title="Retenção alvo" desc="Probabilidade de lembrar na hora de revisar. 90% é o padrão; acima de 95% o volume de revisões dispara">
          <Stepper
            value={srs ? Math.round(srs.requestRetention * 100) : 90}
            min={70}
            max={99}
            step={1}
            suffix="%"
            onChange={(v) => saveSrs({ requestRetention: v / 100 })}
          />
        </Row>
        <Divider />
        <Row title="Passos de aprendizado" desc="Repetições no mesmo dia antes de o card graduar. Padrão do Anki: 1m 10m">
          <StepsField
            value={stepsToText(srs?.learningSteps ?? DEFAULT_SRS_SETTINGS.learningSteps)}
            onCommit={(steps) => saveSrs({ learningSteps: steps })}
          />
        </Row>
        <Divider />
        <Row title="Passos de reaprendizado" desc="Depois de um De novo em card fixado. Padrão: 10m">
          <StepsField
            value={stepsToText(srs?.relearningSteps ?? DEFAULT_SRS_SETTINGS.relearningSteps)}
            onCommit={(steps) => saveSrs({ relearningSteps: steps })}
          />
        </Row>
        <Divider />
        <Row title="Antecipar aprendizado" desc="Sem mais nada na fila, cards em aprendizado que vencem em até tantos minutos entram adiantados">
          <Stepper value={srs?.learnAheadMin ?? 20} min={0} max={120} step={5} suffix=" min" onChange={(v) => saveSrs({ learnAheadMin: v })} />
        </Row>
        <Divider />
        <Row title="Intervalo máximo" desc="Em dias. O padrão do Anki (36500) na prática não limita">
          <NumberField
            value={srs?.maximumInterval ?? 36500}
            min={30}
            max={36500}
            onCommit={(v) => saveSrs({ maximumInterval: v })}
          />
        </Row>
        <Divider />
        <div className="py-3.5">
          <div className="text-sm font-medium">Ordem das revisões</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted">
            Cards em aprendizado vêm sempre primeiro. "Mais esquecidos" põe na frente os de menor retenção estimada — bom para atrasos
          </div>
          <div className="no-scrollbar mt-3 flex overflow-x-auto">
            <Segmented<ReviewOrder>
              value={srs?.reviewOrder ?? "due"}
              onChange={(v) => saveSrs({ reviewOrder: v })}
              options={[
                { value: "due", label: "Vencimento" },
                { value: "retrievability", label: "Mais esquecidos" },
                { value: "random", label: "Aleatória" },
              ]}
              size="sm"
            />
          </div>
        </div>
        <Divider />
        <div className="py-3.5">
          <div className="text-sm font-medium">Palavras novas</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted">
            Misturadas entre os vencidos, ou todas antes/depois deles
          </div>
          <div className="no-scrollbar mt-3 flex overflow-x-auto">
            <Segmented<NewOrder>
              value={srs?.newOrder ?? "mix"}
              onChange={(v) => saveSrs({ newOrder: v })}
              options={[
                { value: "mix", label: "Misturadas" },
                { value: "before", label: "Antes" },
                { value: "after", label: "Depois" },
              ]}
              size="sm"
            />
          </div>
        </div>
        <Divider />
        <Row title="Variar os intervalos" desc="Pequeno desvio aleatório para cards da mesma dose não vencerem todos no mesmo dia">
          <Toggle checked={srs?.enableFuzz ?? true} onChange={(v) => saveSrs({ enableFuzz: v })} />
        </Row>
      </Card>
    </div>
  );
}
