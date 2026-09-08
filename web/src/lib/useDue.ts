// Reatividade *temporal* da revisão.
//
// `useLiveQuery` reage a escritas no IndexedDB, mas um card "vencer" não é uma
// escrita — é o relógio passando. Sem isto, o contador de vencidos só mudava
// quando algo era gravado, e o aluno precisava dar F5 para os cards aparecerem.
import { useEffect, useState } from "react";
import { liveQuery, type Subscription } from "dexie";
import { useLiveQuery } from "dexie-react-hooks";
import { countDue, nextDueAt } from "./srs";

const FALLBACK_MS = 60_000; // nada agendado: reavalia de minuto em minuto
const MAX_SLEEP_MS = 600_000; // e nunca dorme mais que 10 min de uma vez

/**
 * Um relógio por idioma, compartilhado por todos os componentes.
 *
 * O contador de vencidos aparece em três lugares ao mesmo tempo (barra lateral,
 * barra de baixo no celular e o Hoje). Com um timer por componente eram três
 * despertadores e três varreduras da tabela `cards` a cada tique, todos para
 * chegar ao mesmo número. Agora o timer é um só e os componentes só escutam.
 *
 * Ele acorda por dois motivos diferentes, e precisa dos dois:
 *   • o tempo passou (o `setTimeout` até o próximo vencimento);
 *   • o banco mudou (`liveQuery`) — avaliar um card muda qual é o próximo
 *     vencimento, e um "De novo" pode adiantá-lo de 10 min para 1 min.
 */
interface Clock {
  tick: number;
  listeners: Set<(t: number) => void>;
  timer: ReturnType<typeof setTimeout> | null;
  sub: Subscription | null;
  stop: () => void;
}

const clocks = new Map<string, Clock>();

function clockFor(language: string): Clock {
  const hit = clocks.get(language);
  if (hit) return hit;

  const clock: Clock = {
    tick: 0,
    listeners: new Set(),
    timer: null,
    sub: null,
    stop: () => {},
  };

  /** Arma o despertador para o próximo vencimento conhecido. */
  const armTimer = (nextAt: number | null) => {
    if (clock.timer) clearTimeout(clock.timer);
    clock.timer = null;
    if (!clock.listeners.size) return;
    const delay =
      nextAt == null
        ? FALLBACK_MS
        : Math.min(Math.max(nextAt - Date.now() + 250, 1_000), MAX_SLEEP_MS);
    clock.timer = setTimeout(bump, delay);
  };

  /** Reconsulta o próximo vencimento e reagenda. Usado quando o TEMPO passou:
   *  o card que acabou de vencer sai da conta (`due > now`) e o alvo vira o
   *  seguinte — sem isso o delay batia no piso e o relógio girava a cada 1 s. */
  const refresh = async () => {
    if (!clock.listeners.size) return;
    try {
      armTimer(await nextDueAt(language));
    } catch {
      armTimer(null); // banco indisponível: cai no intervalo de segurança
    }
  };

  function bump() {
    clock.tick++;
    for (const fn of clock.listeners) fn(clock.tick);
    void refresh();
  }

  // Timers não são confiáveis com a aba em segundo plano (throttling) nem
  // depois de o aparelho suspender: no retorno, reavalia imediatamente.
  const onWake = () => {
    if (document.visibilityState === "visible") bump();
  };
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("focus", onWake);
  window.addEventListener("online", bump);

  // O banco mudou → reagenda (não conta um tique: quem observa o número já
  // reage à escrita pelo próprio `useLiveQuery`).
  clock.sub = liveQuery(() => nextDueAt(language)).subscribe({
    next: (nextAt) => armTimer(nextAt),
    error: () => armTimer(null),
  });

  clock.stop = () => {
    if (clock.timer) clearTimeout(clock.timer);
    clock.timer = null;
    clock.sub?.unsubscribe();
    clock.sub = null;
    document.removeEventListener("visibilitychange", onWake);
    window.removeEventListener("focus", onWake);
    window.removeEventListener("online", bump);
    clocks.delete(language);
  };

  clocks.set(language, clock);
  return clock;
}

/**
 * Contador que avança quando o próximo card vence, quando a aba volta ao foco
 * (voltar depois de horas deve atualizar na hora) e, por segurança, a cada
 * minuto.
 */
export function useDueTick(language: string | null): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!language) return;
    const clock = clockFor(language);
    clock.listeners.add(setTick);
    // entra já com o tique corrente: quem monta depois não fica um passo atrás
    setTick(clock.tick);
    return () => {
      clock.listeners.delete(setTick);
      if (!clock.listeners.size) clock.stop();
    };
  }, [language]);

  return tick;
}

/** Quantidade de cards vencidos agora — viva no tempo e no banco. */
export function useDueCount(language: string | null): number {
  const tick = useDueTick(language);
  return (
    useLiveQuery(async () => (language ? await countDue(language) : 0), [language, tick]) ?? 0
  );
}
