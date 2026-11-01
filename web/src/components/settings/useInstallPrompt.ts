import { useEffect, useState } from "react";

/**
 * Instalação do PWA. O Chrome/Edge guardam o evento `beforeinstallprompt` e só
 * oferecem "instalar" num menu escondido — aqui a oferta fica visível, e some
 * quando o app já está rodando instalado.
 */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(
    () => window.matchMedia("(display-mode: standalone)").matches,
  );
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };
  return { canInstall: !!deferred, installed, install };
}
