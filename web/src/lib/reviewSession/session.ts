// Sessão de revisão, sem React: a fila de uma dose (fase da dose) ou do idioma
// (revisão avulsa), do carregar ao fechar — incluindo os cards que voltam (De novo,
// learn-ahead), desfazer, «já sei», adiar/suspender/reiniciar, a cota do dia e o
// fecho. A tela só lê `getView()` e chama comandos; não há setter nem ref exposto.
//
// Os comandos rodam em FILA (um de cada vez): dois toques seguidos não avançam a
// fila duas casas nem dão duas notas, e dois "Desfazer" mexem nos dois cards certos.
import { State } from "ts-fsrs";
import type { Dose } from "@/types/dose";
import { isSentenceCard } from "@/lib/cards";
import {
  buildDoseQueue, buildDueQueue, buryCard, dueLearning, forgetCard, freshCard, getSrsSettings,
  gradeCard, gradeNew, markKnown, suspendCard, undoGrade,
  type GradeResult, type QueueScope, type ReviewRating, type SrsSettings,
} from "@/lib/srs";
import type { CardRecord } from "@/lib/db";
import { resolveQueue, resolveRecord, type ResolveCtx } from "./resolve";
import {
  countRemaining, dropAhead, errorText, kindOf, mergeReturned, remountAt, rewindAt,
  type DoseEntry, type Kind, type ResolvedItem,
} from "./queue";

export interface ReviewSummary {
  reviewed: number;
  newLearned: number;
  again: number;
}

/** Ações do menu do card (adiar, suspender, reiniciar). */
export type Acao = "bury" | "suspend" | "forget";

/** Em que parte da sessão a tela está. */
export type Estado = "carregando" | "card" | "conferindo" | "fim" | "cota";

/** A visão que a tela desenha. Imutável por versão: muda só a cada notificação. */
export interface ReviewView {
  estado: Estado;
  /** A fila montada veio vazia desde o início (nada para estudar agora). */
  vazia: boolean;
  atual: ResolvedItem | null;
  tipoAtual: Kind | null;
  pos: number;
  total: number;
  /** Quantos itens faltam a partir de `pos` (inclusive o atual). */
  restam: number;
  faltam: Record<Kind, number>;
  resumo: ReviewSummary;
  podeDesfazer: boolean;
  /** Último erro de gravação/consulta; convive com qualquer estado. */
  falha: string | null;
  /** O fecho (onDone) já foi disparado para o fim atual da fila. */
  fechado: boolean;
  fechando: boolean;
  erroAoFechar: string | null;
  /** > 0: a cota de palavras novas do dia acabou (a dose não fecha). */
  heldBack: number;
  settings: SrsSettings | null;
}

export interface ReviewSessionOptions {
  language: string;
  /** Fase da dose: a fila é a dose (novos + vencidos dela). Sem isto, revisão avulsa. */
  introduce?: Dose;
  /** Fecho da sessão. Sem ele, a sessão é a revisão avulsa (não fecha). */
  onDone?: (summary: ReviewSummary) => void | Promise<void>;
  /** Relógio do módulo, em ms. Padrão: `Date.now`. */
  now?: () => number;
}

export interface ReviewSession {
  subscribe(listener: () => void): () => void;
  getView(): ReviewView;
  /** Monta a fila. Chamado uma vez ao abrir a tela. */
  start(): Promise<void>;
  /** Para de aplicar resultados (a tela foi desmontada). */
  dispose(): void;
  grade(rating: ReviewRating, elapsedMs: number): Promise<void>;
  known(): Promise<void>;
  undo(): Promise<void>;
  act(acao: Acao): Promise<void>;
  /** "Concluir" da fila vazia (fase da dose). Trava: uma chamada por vez. */
  close(): Promise<void>;
  /** Recomeça com a fila atual (recarrega do banco). */
  reload(): Promise<void>;
  /** Confere o fim da fila de novo (depois de uma falha). */
  retry(): Promise<void>;
}

type Entrada = { grade: GradeResult; rating: ReviewRating; isNew: boolean; known?: boolean };

export function createReviewSession(opts: ReviewSessionOptions): ReviewSession {
  const { language, introduce, onDone } = opts;
  const now = opts.now ?? (() => Date.now());
  // De onde vêm os cards que VOLTAM: a dose (fase da dose) ou o idioma (avulsa).
  // É o banco que define o conjunto — não uma lista em memória, que uma recarga perdia.
  const scope: QueueScope = introduce ? { language, doseId: introduce.id } : { language };

  const doseCache = new Map<string, DoseEntry>();
  const seen = new Map<string, ResolvedItem>();
  let uidSeq = 0;
  const nextUid = () => ++uidSeq;
  const ctx: ResolveCtx = { language, doseCache, seen, nextUid };

  let settings: SrsSettings | null = null;
  let items: ResolvedItem[] | null = null;
  let pos = 0;
  // A fila desta montagem já teve card? Adiar o último esvazia a lista, e sem isto
  // a sessão cairia em "Nada para revisar" em vez de fechar como qualquer fim.
  let hadCards = false;
  let heldBack = 0;
  let summary: ReviewSummary = { reviewed: 0, newLearned: 0, again: 0 };
  let history: Entrada[] = [];
  let falha: string | null = null;
  // Tamanho da fila para o qual já se conferiu que nada está vencido nem prestes a
  // vencer. Diferente do tamanho atual = a tela mostra "conferindo".
  let settledFor = -1;
  let fechado = false;
  let fechando = false;
  let erroAoFechar: string | null = null;
  let disposed = false;

  const listeners = new Set<() => void>();
  let cached: ReviewView | null = null;
  const changed = () => {
    cached = null;
    for (const l of listeners) l();
  };

  const setItems = (next: ResolvedItem[] | null) => {
    items = next;
    if (next == null) hadCards = false;
    else if (next.length > 0) hadCards = true;
  };

  const finished = () => items != null && pos >= items.length && (items.length > 0 || hadCards);

  // ---- fila de comandos: um por vez ----
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  const resolveRec = (rec: CardRecord) => resolveRecord(ctx, rec);

  /** Insere os que voltaram sem repetir o que está à frente. */
  const insertReturned = (extra: ResolvedItem[], justGraded: string | null, atEnd: boolean) => {
    if (!extra.length || !items) return;
    setItems(mergeReturned(items, extra, pos, justGraded, atEnd));
  };

  /** Um "De novo" que já venceu volta logo depois do card em tela. */
  const requeueDue = async (justGraded: string) => {
    try {
      const due = await dueLearning(scope, 0, now());
      if (!due.length) return;
      const extra: ResolvedItem[] = [];
      for (const rec of due) {
        const it = await resolveRec(rec);
        if (it) extra.push(it);
      }
      insertReturned(extra, justGraded, false);
    } catch {
      /* a conferência do meio da sessão é oportunista; o fim da fila refaz */
    }
  };

  /** Remonta o card em tela (novo `uid`) — destrava o Flashcard depois de uma falha. */
  const remount = () => {
    if (items) setItems(remountAt(items, pos, nextUid()));
  };

  /**
   * Fim da fila: os cards do escopo que venceram (ou vencem nos próximos minutos —
   * learn-ahead do Anki) entram no fim. Só então, sem mais nada, a sessão fecha.
   * Com a cota do dia estourada, a dose não fecha sozinha.
   */
  async function conferirFim() {
    if (disposed || !items || !finished() || fechado || settledFor === items.length) return;
    const total = items.length;
    const extra: ResolvedItem[] = [];
    try {
      const due = await dueLearning(scope, settings?.learnAheadMin ?? 0, now());
      for (const rec of due) {
        const it = await resolveRec(rec);
        if (it) extra.push(it);
      }
    } catch (err) {
      if (disposed) return;
      // sem conseguir conferir, não fecha por conta própria: fica o aviso e "Conferir de novo"
      falha = `Não deu para conferir a fila (${errorText(err)}).`;
      settledFor = total;
      changed();
      return;
    }
    if (disposed) return;
    if (extra.length) {
      insertReturned(extra, null, true);
      changed();
      return;
    }
    settledFor = total;
    changed();
    if (heldBack > 0 || !onDone) return;
    fechado = true;
    changed();
    // o fecho pode ser assíncrono (a dose grava antes de trocar de fase); não bloqueia a fila
    void (async () => {
      try {
        await onDone(summary);
      } catch (err) {
        fechado = false;
        falha = errorText(err);
        changed();
      }
    })();
  }

  async function carregar() {
    try {
      const s = await getSrsSettings();
      const built = introduce
        ? await buildDoseQueue(introduce, s)
        : { entries: await buildDueQueue(language, s), heldBack: 0 };
      const resolved = await resolveQueue(ctx, built.entries);
      if (disposed) return;
      settings = s;
      setItems(resolved);
      heldBack = built.heldBack;
    } catch (err) {
      if (disposed) return;
      falha = errorText(err);
      setItems([]);
      // a cota de uma carga anterior esconderia o erro atrás do aviso de cota
      heldBack = 0;
    }
    changed();
  }

  const start = () => {
    disposed = false;
    return enqueue(carregar);
  };

  const dispose = () => {
    disposed = true;
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const itemAtual = (uid: number | undefined): ResolvedItem | null => {
    if (uid == null || !items) return null;
    const it = items[pos];
    return it && it.uid === uid ? it : null;
  };

  const grade = (rating: ReviewRating, elapsedMs: number) => {
    // o card é o que estava em tela AO CLICAR; se a fila andou antes da vez dele, nada
    const uid = items?.[pos]?.uid;
    return enqueue(async () => {
      const item = itemAtual(uid);
      if (!item) return;
      let g: GradeResult | null = null;
      try {
        if (item.isNew) g = await gradeNew(item.dose, item.card, rating, elapsedMs, settings ?? undefined);
        else if (item.rec) {
          // o registro fresco, não o da fila: um desfazer ou uma sincronização
          // mudaram o estado, e a nota seria calculada em cima de um velho
          const fresh = await freshCard(item.key, item.rec);
          g = await gradeCard(fresh, rating, elapsedMs, settings ?? undefined);
        }
      } catch (err) {
        // nada foi gravado: o card fica, com os botões vivos, e o aluno vê o porquê
        falha = `Não deu para salvar a nota (${errorText(err)}). Tente de novo.`;
        remount();
        changed();
        return;
      }
      falha = null;
      if (g) history = [...history, { grade: g, rating, isNew: item.isNew }];
      summary = {
        reviewed: summary.reviewed + 1,
        newLearned: summary.newLearned + (item.isNew ? 1 : 0),
        again: summary.again + (rating === 1 ? 1 : 0),
      };
      pos += 1;
      changed();
      await requeueDue(item.key);
      await conferirFim();
    });
  };

  const known = () => {
    const uid = items?.[pos]?.uid;
    return enqueue(async () => {
      const item = itemAtual(uid);
      if (!item) return;
      // só palavra nova (nunca frase), como o botão do card
      if (isSentenceCard(item.card) || !(item.isNew || item.rec?.state === State.New)) return;
      let g: GradeResult;
      try {
        g = await markKnown(item.dose, item.card);
      } catch (err) {
        falha = `Não deu para marcar (${errorText(err)}).`;
        remount();
        changed();
        return;
      }
      falha = null;
      history = [...history, { grade: g, rating: 3, isNew: item.isNew, known: true }];
      pos += 1;
      changed();
      await conferirFim();
    });
  };

  const undo = () =>
    enqueue(async () => {
      const last = history[history.length - 1];
      if (!last) return;
      try {
        await undoGrade(last.grade);
      } catch (err) {
        falha = `Não deu para desfazer (${errorText(err)}).`;
        changed();
        return;
      }
      history = history.slice(0, -1);
      if (!last.known) {
        summary = {
          reviewed: Math.max(0, summary.reviewed - 1),
          newLearned: Math.max(0, summary.newLearned - (last.isNew ? 1 : 0)),
          again: Math.max(0, summary.again - (last.rating === 1 ? 1 : 0)),
        };
      }
      const idx = Math.max(0, pos - 1);
      pos = idx;
      // desfez na tela "concluída"? a sessão reabre e confere a fila de novo
      fechado = false;
      settledFor = -1;
      // o card volta como "não visto" se nasceu nessa nota; uma volta dele já
      // enfileirada mais à frente sai (carregava o estado desfeito)
      if (items) setItems(rewindAt(items, idx, last.grade.prev, nextUid()));
      changed();
    });

  const act = (acao: Acao) => {
    const uid = items?.[pos]?.uid;
    return enqueue(async () => {
      const item = itemAtual(uid);
      if (!item?.rec) return;
      let rec: CardRecord;
      try {
        // o registro fresco: gravar o da fila de volta desfaria um estado novo em silêncio
        const fresh = await freshCard(item.key, item.rec);
        if (acao === "bury") rec = await buryCard(fresh);
        else if (acao === "suspend") rec = await suspendCard(fresh);
        else rec = await forgetCard(fresh, settings ?? undefined);
      } catch (err) {
        falha = `Não deu para aplicar a ação (${errorText(err)}).`;
        remount();
        changed();
        return;
      }
      falha = null;
      // some da sessão: adiado/suspenso não volta; reiniciado vira novo
      seen.set(item.key, { ...item, rec });
      // só daqui para a frente: o passado não encolhe
      if (items) setItems(dropAhead(items, pos, item.key));
      changed();
      await conferirFim();
    });
  };

  const close = async () => {
    if (!onDone || fechando) return;
    fechando = true;
    erroAoFechar = null;
    changed();
    try {
      await onDone(summary);
    } catch (err) {
      erroAoFechar = errorText(err);
    } finally {
      fechando = false;
      changed();
    }
  };

  const reload = () =>
    enqueue(async () => {
      fechado = false;
      pos = 0;
      settledFor = -1;
      falha = null;
      setItems(null);
      changed();
      await carregar();
    });

  const retry = () =>
    enqueue(async () => {
      falha = null;
      settledFor = -1;
      changed();
      await conferirFim();
    });

  function computeView(): ReviewView {
    const total = items?.length ?? 0;
    const fim = finished();
    let estado: Estado;
    let vazia = false;
    if (items == null) estado = "carregando";
    else if (!fim) {
      if (total === 0) {
        // nada na fila desde o início: cota (palavras novas) ou simplesmente nada a estudar
        estado = heldBack > 0 ? "cota" : "fim";
        vazia = true;
      } else estado = "card";
    } else if (settledFor !== total) estado = "conferindo";
    else estado = heldBack > 0 ? "cota" : "fim";
    const atual = items && pos < total ? items[pos] : null;
    return {
      estado,
      vazia,
      atual,
      tipoAtual: atual ? kindOf(atual) : null,
      pos,
      total,
      restam: Math.max(0, total - pos),
      faltam: countRemaining(items, pos),
      resumo: summary,
      podeDesfazer: history.length > 0,
      falha,
      fechado,
      fechando,
      erroAoFechar,
      heldBack,
      settings,
    };
  }

  return {
    subscribe,
    getView: () => {
      if (!cached) cached = computeView();
      return cached;
    },
    start,
    dispose,
    grade,
    known,
    undo,
    act,
    close,
    reload,
    retry,
  };
}
