import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, useApp } from "@/lib/store";
import { resetAll, resetLanguage } from "@/lib/db";
import { startAutoSync } from "@/lib/sync";
import { hydrateAuth } from "@/lib/auth";
import "./index.css";

// Apply the persisted theme before first paint to avoid a flash.
applyTheme(useApp.getState().theme);

async function mount() {
  // a sessão da conta é lida ANTES do primeiro render: senão a tela de entrar
  // piscava para quem já está logado (o porteiro em App.tsx decide por ela)
  await hydrateAuth();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Sincronização entre aparelhos: só faz algo com uma conta (ou código) ativa.
  startAutoSync();
}

// Service worker: app instalável e utilizável offline (só em produção — em dev
// ele mascararia o HMR). Ver public/sw.js para a política de cache.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
      /* sem SW: o app segue funcionando normalmente, só não fica offline */
    });
  });
}

// ?reset=all wipes everything; ?reset=<lang> (e.g. ?reset=ko) wipes one language's
// SRS + progress. Then it redirects to a clean URL and mounts fresh.
// Sempre com confirmação: o reset grava tombstones e, com conta, se propaga para
// o servidor e os outros aparelhos — um link aberto sem querer (histórico,
// autocompletar da barra) apagava a conta inteira em silêncio.
const resetParam = new URLSearchParams(location.search).get("reset");
if (resetParam) {
  const what = resetParam === "all" ? "TODO o progresso" : `o progresso do idioma «${resetParam}»`;
  const ok = confirm(
    `Apagar ${what} (cards, revisões, estatísticas)?\n\n` +
    "Com conta, isso vale também para a conta e para os outros aparelhos.",
  );
  (ok ? (resetParam === "all" ? resetAll() : resetLanguage(resetParam)) : Promise.resolve()).finally(() => {
    location.replace(location.pathname + location.hash);
  });
} else {
  void mount();
}
