// Orquestração da sessão de revisão: estado da fila, nota, «já sei», desfazer,
// adiar/suspender/reiniciar, cards que voltam e o fecho da fila. A tela
// (ReviewSession.tsx) só desenha o que este hook devolve.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Dose } from "@/types/dose";
import {
  buildDoseQueue, buildDueQueue, buryCard, dueLearning, forgetCard, getSrsSettings, gradeCard,
  gradeNew, markKnown, suspendCard, undoGrade, freshCard,
  type GradeResult, type QueueScope, type ReviewRating, type SrsSettings,
} from "@/lib/srs";
import type { CardRecord } from "@/lib/db";
import type { CardAction } from "./Flashcard";
import {
  countRemaining, dropAhead, errorText, kindOf, mergeReturned, remountAt, rewindAt,
  type DoseEntry, type ResolvedItem,
} from "./reviewQueue";
import { resolveQueue, resolveRecord, type ResolveCtx } from "./resolveItems";
import { useDueTick, useDueCount } from "@/lib/useDue";
import { useHotkeys, isTypingTarget } from "@/lib/hooks";

export interface ReviewSummary {
  reviewed: number;
  newLearned: number;
  again: number;
}

export function useReviewSession({
  language,
  introduce,
  onDone,
}: {
  language: string;
  introduce?: Dose;
  onDone?: (summary: ReviewSummary) => void | Promise<void>;
}) {
  const [settings, setSettings] = useState<SrsSettings | null>(null);
  const [items, setItems] = useState<ResolvedItem[] | null>(null);
  // > 0 = a fila veio vazia porque o teto de palavras novas do dia acabou, não
  // porque a dose acabou. Muda a mensagem e tira o "Concluir" (ver abaixo).
  const [heldBack, setHeldBack] = useState(0);
  const [pos, setPos] = useState(0);
  // espelho de `pos` para handlers que precisam do valor atual sem depender do
  // fechamento do render (ver `undo`)
  const posRef = useRef(0);
  posRef.current = pos;
  const [queueKey, setQueueKey] = useState(0);
  const doneFired = useRef(false);
  const [summary, setSummary] = useState<ReviewSummary>({ reviewed: 0, newLearned: 0, again: 0 });
  // Fim da fila: `settledFor` é o tamanho da fila para o qual já se conferiu
  // que nada da sessão está vencido nem prestes a vencer. Enquanto for
  // diferente do tamanho atual, a tela mostra "conferindo" — nunca um
  // "Revisão concluída" de um quadro, seguido do card que voltou.
  const [settledFor, setSettledFor] = useState(-1);
  const [recheck, setRecheck] = useState(0);
  // Falha ao gravar/consultar (banco fechado pelo navegador, cota, etc.). Antes
  // a nota se perdia em silêncio e o card ficava morto na tela.
  const [fault, setFault] = useState<string | null>(null);
  const doseCache = useRef(new Map<string, DoseEntry>());
  // Tudo que já passou pela sessão (por chave): atalho para montar um card que
  // volta sem baixar a dose de novo.
  const seen = useRef(new Map<string, ResolvedItem>());
  const uidSeq = useRef(0);
  const nextUid = () => ++uidSeq.current;

  // De onde vêm os cards que VOLTAM (De novo em 1 min, learn-ahead no fim):
  // da dose, na fase da dose; do idioma inteiro, na revisão avulsa. É o banco
  // que define o conjunto — não uma lista em memória, que uma recarga perdia.
  const scope: QueueScope = useMemo(
    () => (introduce ? { language, doseId: introduce.id } : { language }),
    [language, introduce?.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const ctx: ResolveCtx = { language, doseCache: doseCache.current, seen: seen.current, nextUid };
  /** Monta o item de um registro (card já visto), pela cache ou baixando a dose. */
  const resolveRec = (rec: CardRecord) => resolveRecord(ctx, rec);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await getSrsSettings();
        const built = introduce
          ? await buildDoseQueue(introduce, s)
          : { entries: await buildDueQueue(language, s), heldBack: 0 };
        const resolved = await resolveQueue(ctx, built.entries);
        if (alive) {
          setSettings(s);
          setItems(resolved);
          setHeldBack(built.heldBack);
        }
      } catch (err) {
        if (alive) {
          setFault(errorText(err));
          setItems([]);
          // a cota de uma carga anterior esconderia o erro atrás do aviso de cota
          setHeldBack(0);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, introduce?.id, queueKey]);

  const total = items?.length ?? 0;
  const current = items && pos < total ? items[pos] : null;
  // A fila desta montagem já teve card? Adiar/suspender o último card esvazia a
  // lista, e sem isto a tela caía em "Nada para revisar agora" em vez de fechar
  // a sessão como qualquer outro fim de fila.
  const hadCards = useRef(false);
  if (items == null) hadCards.current = false;
  else if (total > 0) hadCards.current = true;
  const finished = items != null && pos >= total && (total > 0 || hadCards.current);

  // Revisão avulsa: a tela precisa acordar sozinha quando um card vence.
  // Na fase da dose (`introduce`) não — a fila é fechada e terminar significa
  // fim da lição.
  const standalone = onDone == null;
  const tick = useDueTick(standalone ? language : null);
  const dueNow = useDueCount(standalone ? language : null);
  /** Vencidos que ainda não estão na fila montada. */
  const pending = standalone ? Math.max(0, dueNow - (total - pos)) : 0;

  // Fila vazia + algo venceu = carrega sem pedir nada ao aluno. Este é o caso
  // do "Nada para revisar agora" que antes só saía com F5.
  useEffect(() => {
    if (!standalone || tick === 0) return;
    if (items != null && total === 0 && dueNow > 0) setQueueKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, dueNow]);

  /** Recomeça com a fila atual (usado no fim da sessão). */
  const loadMore = () => {
    doneFired.current = false;
    posRef.current = 0;
    setPos(0);
    setItems(null);
    setSettledFor(-1);
    setQueueKey((k) => k + 1);
  };

  // Pilha de avaliações desta sessão, para o "desfazer".
  const [history, setHistory] = useState<{ grade: GradeResult; rating: ReviewRating; isNew: boolean; known?: boolean }[]>([]);

  /** Insere na fila os cards que voltaram, sem repetir o que já está à frente. */
  const insertReturned = (extra: ResolvedItem[], justGraded: string | null, atEnd: boolean) => {
    if (!extra.length) return;
    setItems((prev) => (prev ? mergeReturned(prev, extra, posRef.current, justGraded, atEnd) : prev));
  };

  /**
   * Como no Anki, um card em aprendizado **volta no meio da sessão** assim que
   * vence (um "De novo" retorna em ~1 min, não só no fim da fila). Entra logo
   * depois do card em tela — nunca no lugar dele, que já está sendo lido.
   */
  const requeueDue = async (justGraded: string) => {
    try {
      const due = await dueLearning(scope);
      if (!due.length) return;
      const extra: ResolvedItem[] = [];
      for (const rec of due) {
        const it = await resolveRec(rec);
        if (it) extra.push(it);
      }
      insertReturned(extra, justGraded, false);
    } catch {
      /* a conferência do meio da sessão é oportunista; o fecho da fila refaz */
    }
  };

  /** Remonta o card em tela (novo `uid`) — destrava o Flashcard depois de uma falha. */
  const remountCurrent = () => {
    setItems((prev) => (prev ? remountAt(prev, posRef.current, nextUid()) : prev));
  };

  // A card only "counts" (record created / daily new-count bumped) once graded.
  const onGrade = async (item: ResolvedItem, rating: ReviewRating, elapsedMs: number) => {
    // só o card da vez recebe nota (o Flashcard já barra a nota dupla; isto é a
    // segunda tranca, para a fila nunca avançar duas casas com um toque)
    if (items?.[posRef.current]?.uid !== item.uid) return;
    let grade: GradeResult | null = null;
    try {
      if (item.isNew) grade = await gradeNew(item.dose, item.card, rating, elapsedMs, settings ?? undefined);
      else if (item.rec) {
        // O registro fresco, não o guardado no item: um card que voltou para a
        // fila antes de um "desfazer" (ou que a sincronização atualizou) traria
        // um estado velho, e a nota seria calculada em cima dele.
        const fresh = await freshCard(item.key, item.rec);
        grade = await gradeCard(fresh, rating, elapsedMs, settings ?? undefined);
      }
    } catch (err) {
      // Nada foi gravado: o card fica, com os botões vivos, e o aluno vê o porquê.
      setFault(`Não deu para salvar a nota (${errorText(err)}). Tente de novo.`);
      remountCurrent();
      return;
    }
    setFault(null);
    if (grade) setHistory((h) => [...h, { grade, rating, isNew: item.isNew }]);
    setSummary((s) => ({
      reviewed: s.reviewed + 1,
      newLearned: s.newLearned + (item.isNew ? 1 : 0),
      again: s.again + (rating === 1 ? 1 : 0),
    }));
    posRef.current += 1;
    setPos((p) => p + 1);
    void requeueDue(item.key);
  };

  /** «Já sei»: a palavra sai da fila sem nota (e sem gastar a cota). Desfazível. */
  const onKnown = async (item: ResolvedItem) => {
    if (items?.[posRef.current]?.uid !== item.uid) return;
    let grade: GradeResult;
    try {
      grade = await markKnown(item.dose, item.card);
    } catch (err) {
      setFault(`Não deu para marcar (${errorText(err)}).`);
      remountCurrent();
      return;
    }
    setFault(null);
    setHistory((h) => [...h, { grade, rating: 3 as ReviewRating, isNew: item.isNew, known: true }]);
    posRef.current += 1;
    setPos((p) => p + 1);
  };

  /** Reverte a última nota: estado FSRS, log e contadores do dia. */
  const undo = async () => {
    const last = history[history.length - 1];
    if (!last) return;
    try {
      await undoGrade(last.grade);
    } catch (err) {
      setFault(`Não deu para desfazer (${errorText(err)}).`);
      return;
    }
    setHistory((h) => h.slice(0, -1));
    if (!last.known) setSummary((s) => ({
      reviewed: Math.max(0, s.reviewed - 1),
      newLearned: Math.max(0, s.newLearned - (last.isNew ? 1 : 0)),
      again: Math.max(0, s.again - (last.rating === 1 ? 1 : 0)),
    }));
    // O índice sai da ref, não do `pos` do render: dois cliques seguidos em
    // "Desfazer" liam o mesmo valor antigo e mexiam no card errado.
    const idx = Math.max(0, posRef.current - 1);
    posRef.current = idx;
    setPos(idx);
    // Desfez na tela "Revisão concluída"? A sessão reabre: o fecho precisa
    // conferir a fila de novo quando o card for reavaliado, não cair direto
    // em "concluída" pulando o learn-ahead.
    doneFired.current = false;
    setSettledFor(-1);
    // O card volta para a fila como "não visto" se ele nasceu nessa nota.
    // Uma volta dele já enfileirada mais à frente (De novo → requeue, ou o
    // learn-ahead do fim) carregava o estado desfeito: sai, e a próxima nota
    // decide de novo se ele volta.
    setItems((prev) => (prev ? rewindAt(prev, idx, last.grade.prev, nextUid()) : prev));
  };

  /** Adiar / suspender / reiniciar o card em tela (só cards já vistos). */
  const onAction = async (item: ResolvedItem, action: CardAction) => {
    if (!item.rec || items?.[posRef.current]?.uid !== item.uid) return;
    let rec: CardRecord;
    try {
      // o registro fresco, como na nota: o do item pode ser de antes de um
      // "desfazer" ou de uma sincronização, e gravá-lo inteiro de volta
      // desfaria esse estado FSRS em silêncio
      const fresh = await freshCard(item.key, item.rec);
      if (action === "bury") rec = await buryCard(fresh);
      else if (action === "suspend") rec = await suspendCard(fresh);
      else rec = await forgetCard(fresh, settings ?? undefined);
    } catch (err) {
      setFault(`Não deu para aplicar a ação (${errorText(err)}).`);
      remountCurrent();
      return;
    }
    setFault(null);
    // some da sessão: adiado/suspenso não volta (isActive); reiniciado vira novo
    seen.current.set(item.key, { ...item, rec });
    // só daqui para a frente: um card que voltou (De novo) também está ATRÁS
    // na fila, e tirá-lo de lá encurtava o passado — `pos` pulava um card
    setItems((prev) => (prev ? dropAhead(prev, posRef.current, item.key) : prev));
  };

  // Ctrl+Z / Z desfaz, como no Anki.
  useHotkeys((e) => {
    if (isTypingTarget(e) || e.repeat) return;
    if (e.key.toLowerCase() === "z" && !e.altKey) {
      if (history.length) {
        e.preventDefault();
        void undo();
      }
    }
  });

  // Fim da fila: os cards do escopo que já venceram de novo entram no fim,
  // e — sem mais nada para estudar — também os que vencem nos próximos minutos
  // (Anki: "learn ahead"). Sem isso a dose fechava com o card reprovado
  // pendurado, ou o aluno esperava 10 min pelo segundo passo do aprendizado.
  // A sessão só termina quando nada dela está vencido nem prestes a vencer.
  useEffect(() => {
    if (!finished || doneFired.current || settledFor === total) return;
    let alive = true;
    (async () => {
      let extra: ResolvedItem[] = [];
      try {
        const due = await dueLearning(scope, settings?.learnAheadMin ?? 0);
        for (const rec of due) {
          const it = await resolveRec(rec);
          if (it) extra.push(it);
        }
      } catch (err) {
        if (!alive) return;
        // Sem conseguir conferir, não fecha a dose por conta própria: fica o
        // aviso e um botão para tentar de novo.
        setFault(`Não deu para conferir a fila (${errorText(err)}).`);
        setSettledFor(total);
        return;
      }
      if (!alive) return;
      if (extra.length) {
        insertReturned(extra, null, true);
        return;
      }
      setSettledFor(total);
      // Cota do dia estourada (só existe na sessão de dose): a dose não fecha
      // sozinha, senão as palavras novas que faltam somem da trilha.
      if (heldBack > 0) return;
      doneFired.current = true;
      // onDone pode ser assíncrono (a dose grava antes de trocar de fase).
      void Promise.resolve(onDone?.(summary)).catch((err) => {
        // falhou: volta a oferecer "Conferir de novo"
        doneFired.current = false;
        setFault(errorText(err));
      });
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, total, recheck]);

  /**
   * "Concluir" da fila vazia (fase da dose). Uma trava só: dois toques seguidos
   * chamavam `onDone` duas vezes (gravação e troca de fase em dobro).
   */
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closingRef = useRef(false);
  const concludeEmpty = () => {
    if (!onDone || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    setCloseError(null);
    let ret: void | Promise<void>;
    try {
      ret = onDone(summary);
    } catch (err) {
      ret = Promise.reject(err);
    }
    void Promise.resolve(ret)
      .catch((err) => {
        setCloseError(errorText(err));
      })
      .finally(() => {
        closingRef.current = false;
        setClosing(false);
      });
  };

  // Contadores à la Anki: o que ainda falta, por tipo, e não "x de N" — a fila
  // cresce e encolhe durante a sessão (cards que voltam), então N mentiria.
  const remaining = useMemo(() => countRemaining(items, pos), [items, pos]);
  const currentKind = current ? kindOf(current) : null;

  return {
    settings, items, heldBack, pos, summary, fault, setFault, settledFor, setSettledFor, setRecheck,
    doneFired, total, current, finished, pending, history, remaining, currentKind,
    loadMore, onGrade, onKnown, undo, onAction, closing, closeError, concludeEmpty,
  };
}
