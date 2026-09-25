// Global UI state + persisted preferences (theme, active language, subtitle prefs).
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light";
export type SubtitleMode = "target" | "translation" | "both" | "primed" | "off";

interface AppState {
  theme: Theme;
  activeLanguage: string | null;
  onboardingDone: boolean;
  // player prefs
  subtitleMode: SubtitleMode;
  playbackRate: number;
  furigana: boolean;
  /** Legenda "conhecido/novo": sublinha o que está em aprendizado e o que ainda
   *  não foi estudado. Opcional e desligado por padrão — é apoio, não a regra. */
  subtitleMarks: boolean;
  /** Transcrição ao lado do vídeo (desktop). Fechada, o vídeo volta ao centro. */
  transcriptOpen: boolean;
  /** Mostrar a palavra no idioma-alvo junto do áudio na frente do flashcard. */
  flashcardFrontText: boolean;
  /** Frase-exemplo (a i+1 da palavra, quando existe) na FRENTE do card de
   *  palavra, com a palavra sublinhada e um botão de ouvir. Só a palavra toca
   *  sozinha ao abrir; a frase, ao toque. */
  flashcardExample: boolean;
  /** Ao revelar a resposta, tocar a frase-exemplo automaticamente. */
  autoPlayExample: boolean;
  /** Prime adaptativo: no modo Primed, pausar só antes das falas que têm palavra
   *  ainda não fixada. Desligado por padrão — o aluno liga em Ajustes → Imersão
   *  (ou no player, no modo Primed). */
  primedAdaptive: boolean;

  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setActiveLanguage: (code: string) => void;
  setOnboardingDone: (v: boolean) => void;
  setSubtitleMode: (m: SubtitleMode) => void;
  setPlaybackRate: (r: number) => void;
  setFurigana: (v: boolean) => void;
  setSubtitleMarks: (v: boolean) => void;
  setTranscriptOpen: (v: boolean) => void;
  setFlashcardFrontText: (v: boolean) => void;
  setFlashcardExample: (v: boolean) => void;
  setAutoPlayExample: (v: boolean) => void;
  setPrimedAdaptive: (v: boolean) => void;
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      theme: "dark",
      activeLanguage: null,
      onboardingDone: false,
      subtitleMode: "both",
      playbackRate: 1,
      furigana: false,
      subtitleMarks: false,
      transcriptOpen: true,
      flashcardFrontText: false,
      flashcardExample: true,
      autoPlayExample: true,
      primedAdaptive: false,

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setActiveLanguage: (activeLanguage) => set({ activeLanguage }),
      setOnboardingDone: (onboardingDone) => set({ onboardingDone }),
      setSubtitleMode: (subtitleMode) => set({ subtitleMode }),
      setPlaybackRate: (playbackRate) => set({ playbackRate }),
      setFurigana: (furigana) => set({ furigana }),
      setSubtitleMarks: (subtitleMarks) => set({ subtitleMarks }),
      setTranscriptOpen: (transcriptOpen) => set({ transcriptOpen }),
      setFlashcardFrontText: (flashcardFrontText) => set({ flashcardFrontText }),
      setFlashcardExample: (flashcardExample) => set({ flashcardExample }),
      setAutoPlayExample: (autoPlayExample) => set({ autoPlayExample }),
      setPrimedAdaptive: (primedAdaptive) => set({ primedAdaptive }),
    }),
    { name: "imersa-prefs" },
  ),
);

/** Aplica o tema ao <html data-theme> e à barra do navegador (theme-color). */
export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#f4f2ec" : "#12181a");
}
