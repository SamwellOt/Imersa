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

  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  setActiveLanguage: (code: string) => void;
  setOnboardingDone: (v: boolean) => void;
  setSubtitleMode: (m: SubtitleMode) => void;
  setPlaybackRate: (r: number) => void;
  setFurigana: (v: boolean) => void;
  setSubtitleMarks: (v: boolean) => void;
  setTranscriptOpen: (v: boolean) => void;
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

      setTheme: (theme) => set({ theme }),
      toggleTheme: () => set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
      setActiveLanguage: (activeLanguage) => set({ activeLanguage }),
      setOnboardingDone: (onboardingDone) => set({ onboardingDone }),
      setSubtitleMode: (subtitleMode) => set({ subtitleMode }),
      setPlaybackRate: (playbackRate) => set({ playbackRate }),
      setFurigana: (furigana) => set({ furigana }),
      setSubtitleMarks: (subtitleMarks) => set({ subtitleMarks }),
      setTranscriptOpen: (transcriptOpen) => set({ transcriptOpen }),
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
