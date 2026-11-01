import { useEffect, useState } from "react";
import { useMediaQuery } from "@/lib/hooks";

/**
 * Modo cinema do player. Devolve se o cinema está aberto, se foi aberto à mão
 * (`cinemaManual`, o estado "ativo" do botão) e o alternador do botão / F / Esc.
 */
export function useCinema(isVideo: boolean) {
  // Cinema: o quadro toma a tela inteira, com os controles por cima de fundo
  // preto (paleta escura forçada). Entra sozinho no celular em paisagem — ali o
  // cabeçalho da dose comia um terço da altura e os controles caíam abaixo da
  // dobra — e à mão pelo botão de tela cheia. Onde o navegador deixa, também
  // pede tela cheia de verdade (esconde a barra de endereço); no iPhone o
  // pedido é ignorado sem erro e fica só o layout.
  const phoneLandscape = useMediaQuery("(orientation: landscape) and (max-height: 520px)");
  const [cinemaManual, setCinemaManual] = useState(false);
  // Na paisagem do celular o aluno pode sair do cinema à mão; a escolha dura
  // enquanto a paisagem durar.
  const [cinemaOff, setCinemaOff] = useState(false);
  useEffect(() => {
    if (!phoneLandscape) setCinemaOff(false);
  }, [phoneLandscape]);
  const cinema = isVideo && (cinemaManual || (phoneLandscape && !cinemaOff));
  const setCinema = (on: boolean) => {
    setCinemaManual(on);
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    try {
      if (on && !document.fullscreenElement) {
        void document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
      } else if (!on && document.fullscreenElement) {
        void (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => {});
      }
    } catch { /* sem tela cheia neste navegador */ }
  };
  // Botão e tecla F: na paisagem do celular o cinema é automático, então sair
  // dele é um override (`cinemaOff`), não um `setCinema(false)` sem efeito.
  const toggleCinema = () => {
    if (!phoneLandscape) return setCinema(!cinema);
    if (cinema) {
      setCinema(false);
      setCinemaOff(true);
    } else {
      setCinemaOff(false);
      setCinema(true);
    }
  };
  // O usuário saiu da tela cheia pelo navegador (Esc, gesto de voltar): o
  // layout acompanha. E enquanto o cinema está aberto a página não rola.
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setCinemaManual(false); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => {
    if (!cinema) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [cinema]);

  return { cinema, cinemaManual, toggleCinema };
}
