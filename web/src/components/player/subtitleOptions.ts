import type { SubtitleMode } from "@/lib/store";

// As mesmas cinco opções no player e nos Ajustes: é o MESMO estado, não um
// "padrão" à parte. Com só três nos Ajustes, quem tivesse deixado o player em
// "PT" via "Ambas" marcado lá — o controle mentia sobre o modo atual e mudava
// tudo ao primeiro toque.
export const SUB_OPTS: { value: SubtitleMode; label: string }[] = [
  { value: "target", label: "Alvo" },
  { value: "translation", label: "PT" },
  { value: "both", label: "Ambas" },
  { value: "primed", label: "Primed" },
  { value: "off", label: "Off" },
];
