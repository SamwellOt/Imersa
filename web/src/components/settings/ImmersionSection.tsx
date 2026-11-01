import { useApp } from "@/lib/store";
import { Card, Divider, SectionLabel, SettingRow as Row } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/Segmented";
import { SUB_OPTS } from "@/components/player/subtitleOptions";
import { Toggle } from "./controls";

/** Ajustes → Imersão: legendas, marcas de palavra, Prime adaptativo, furigana. */
export function ImmersionSection() {
  const app = useApp();
  return (
    <div className="mt-9">
      <SectionLabel>Imersão</SectionLabel>
      <Card className="mt-3 px-5">
        <div className="py-3.5">
          <div className="text-sm font-medium">Legendas</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted">
            O modo em uso no player — trocar aqui ou lá dá no mesmo
          </div>
          <div className="no-scrollbar mt-3 flex overflow-x-auto">
            <Segmented
              value={app.subtitleMode}
              onChange={app.setSubtitleMode}
              options={SUB_OPTS}
              size="sm"
            />
          </div>
        </div>
        <Divider />
        <Row
          title="Marcar palavras por conhecimento"
          desc="Na legenda, sublinha o que está em aprendizado e pontilha o que você ainda não estudou; o já fixado fica limpo"
        >
          <Toggle checked={app.subtitleMarks} onChange={app.setSubtitleMarks} />
        </Row>
        <Divider />
        <Row
          title="Prime adaptativo"
          desc="No modo Primed, o vídeo só pausa antes das falas que têm alguma palavra que você ainda não fixou. As falas que você já entende passam direto. Desligado, pausa em todas"
        >
          <Toggle label="Prime adaptativo" checked={app.primedAdaptive} onChange={app.setPrimedAdaptive} />
        </Row>
        <Divider />
        <Row title="Furigana / leitura" desc="Mostrar a leitura quando disponível">
          <Toggle checked={app.furigana} onChange={app.setFurigana} />
        </Row>
      </Card>
    </div>
  );
}
