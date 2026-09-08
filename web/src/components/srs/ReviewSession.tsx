import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Check, Undo2 } from "lucide-react";
import { State } from "ts-fsrs";
import type { Dose, SentenceCard } from "@/types/dose";
import {
  buildDoseQueue, buildDueQueue, buryCard, dueLearning, forgetCard, getSrsSettings, gradeCard,
  gradeNew, isLearningState, suspendCard, undoGrade,
  type GradeResult, type QueueEntry, type QueueScope, type ReviewRating, type SrsSettings,
} from "@/lib/srs";
import { db, tombstone, type CardRecord } from "@/lib/db";
import { resolveDose, mediaUrl as mediaPath, DoseMissingError } from "@/lib/content";
import { Flashcard, type CardAction } from "./Flashcard";
import { ProgressBar } from "@/components/ui/progress";
import { LoadingScreen, EmptyState } from "@/components/ui/feedback";
import { Button } from "@/components/ui/primitives";
import { useDueTick, useDueCount } from "@/lib/useDue";
import { useHotkeys, isTypingTarget } from "@/lib/hooks";
import { cn, pluralize } from "@/lib/utils";

export interface ReviewSummary {
  reviewed: number;
  newLearned: number;
  again: number;
}

interface ResolvedItem extends QueueEntry {
  /** Id desta APARIÇÃO na fila (um card que volta ganha outro). É a `key` do
   *  `<Flashcard>`: com a chave do card, um card que voltava logo em seguida
   *  (ou o "desfazer" caindo no mesmo card) reaproveitava o componente já
   *  avaliado — botões mortos, verso já aberto. */
  uid: number;
  dose: Dose;
  card: SentenceCard;
  mediaUrl: string; // main dose media (fallback fragment)
  wordAudioUrl?: string; // word TTS clip (front)
  fragmentUrl?: string; // pre-cut example fragment (back)
  sceneUrl?: string; // quadro do vídeo na frase-exemplo (back)
}

type Kind = "new" | "learning" | "review";

function kindOf(it: QueueEntry): Kind {
  if (it.isNew || !it.rec || it.rec.state === State.New) return "new";
  return isLearningState(it.rec) ? "learning" : "review";
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 140 ? msg.slice(0, 140) + "…" : msg;
}

export function ReviewSession({
  language,
  introduce,
  onDone,
  emptyHint,
}: {
  language: string;
  introduce?: Dose; // dose review: offer this dose's unseen cards + due reviews
  onDone?: (summary: ReviewSummary) => void;
  emptyHint?: string;
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
  const doseCache = useRef(new Map<string, { dose: Dose; mediaUrl: string; path: string }>());
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

  /** Monta o item de um registro (card já visto), pela cache ou baixando a dose. */
  const resolveRec = async (rec: CardRecord): Promise<ResolvedItem | null> => {
    const base = seen.current.get(rec.key);
    if (base) return { ...base, rec, isNew: false, uid: nextUid() };
    let entry = doseCache.current.get(rec.doseId);
    if (!entry) {
      try {
        const r = await resolveDose(language, rec.doseId);
        entry = { dose: r.dose, mediaUrl: r.mediaUrl, path: r.path };
        doseCache.current.set(rec.doseId, entry);
      } catch {
        return null; // sem rede e sem cache: fica para a próxima conferência
      }
    }
    const card = entry.dose.cards.find((c) => c.id === rec.cardId);
    if (!card) return null;
    const item: ResolvedItem = {
      key: rec.key, doseId: rec.doseId, cardId: rec.cardId, isNew: false, rec, uid: nextUid(),
      dose: entry.dose,
      card,
      mediaUrl: entry.mediaUrl,
      wordAudioUrl: card.audioClipSrc ? mediaPath(language, entry.path, card.audioClipSrc) : undefined,
      fragmentUrl: card.exampleAudioSrc ? mediaPath(language, entry.path, card.exampleAudioSrc) : undefined,
      sceneUrl: card.sceneSrc ? mediaPath(language, entry.path, card.sceneSrc) : undefined,
    };
    seen.current.set(item.key, item);
    return item;
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await getSrsSettings();
        const built = introduce
          ? await buildDoseQueue(introduce, s)
          : { entries: await buildDueQueue(language, s), heldBack: 0 };
        const q = built.entries;
        const resolved: ResolvedItem[] = [];
        // Registro órfão só é apagado quando a dose/card REALMENTE sumiu do
        // conteúdo. Falha de rede apenas tira o card desta fila — o app é
        // offline-first, e apagar aqui significaria perder o progresso do aluno
        // (e propagar a perda para os outros aparelhos na sincronização).
        const dropStale = async (key: string) => {
          await db.cards.delete(key);
          await tombstone("card", key);
        };
        const fetchEntry = async (doseId: string, fresh = false) => {
          const r = await resolveDose(language, doseId, fresh);
          const entry = { dose: r.dose, mediaUrl: r.mediaUrl, path: r.path };
          doseCache.current.set(doseId, entry);
          return entry;
        };
        /**
         * "Sumiu" segundo a cópia em cache não basta: o `course.json` guardado
         * pelo service worker (e o desta sessão) pode ser de antes de a dose
         * existir — os cards que o outro aparelho estudou nela chegavam pela
         * sincronização e eram apagados aqui, com tombstone, na primeira
         * abertura da revisão. Só a resposta fresca do servidor decide.
         */
        const confirmGone = async (it: QueueEntry): Promise<boolean> => {
          try {
            const fresh = await fetchEntry(it.doseId, true);
            return !fresh.dose.cards.some((c) => c.id === it.cardId);
          } catch (err) {
            return err instanceof DoseMissingError;
          }
        };
        for (const it of q) {
          let entry = doseCache.current.get(it.doseId);
          if (!entry) {
            try {
              entry = await fetchEntry(it.doseId);
            } catch (err) {
              if (it.rec && err instanceof DoseMissingError && (await confirmGone(it))) {
                await dropStale(it.key);
              }
              continue;
            }
          }
          let card = entry.dose.cards.find((c) => c.id === it.cardId);
          if (!card && it.rec) {
            // card id sumiu da dose em cache: a dose fresca pode tê-lo (build novo)
            if (await confirmGone(it)) {
              await dropStale(it.key); // card id no longer exists → self-heal
              continue;
            }
            entry = doseCache.current.get(it.doseId) ?? entry;
            card = entry.dose.cards.find((c) => c.id === it.cardId);
          }
          if (!card) continue;
          const item: ResolvedItem = {
            ...it,
            uid: nextUid(),
            dose: entry.dose,
            card,
            mediaUrl: entry.mediaUrl,
            wordAudioUrl: card.audioClipSrc ? mediaPath(language, entry.path, card.audioClipSrc) : undefined,
            fragmentUrl: card.exampleAudioSrc ? mediaPath(language, entry.path, card.exampleAudioSrc) : undefined,
            sceneUrl: card.sceneSrc ? mediaPath(language, entry.path, card.sceneSrc) : undefined,
          };
          seen.current.set(item.key, item);
          resolved.push(item);
        }
        if (alive) {
          setSettings(s);
          setItems(resolved);
          setHeldBack(built.heldBack);
        }
      } catch (err) {
        if (alive) {
          setFault(errorText(err));
          setItems([]);
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
  const finished = items != null && pos >= total;

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
  const [history, setHistory] = useState<{ grade: GradeResult; rating: ReviewRating; isNew: boolean }[]>([]);

  /** Insere na fila os cards que voltaram, sem repetir o que já está à frente. */
  const insertReturned = (extra: ResolvedItem[], justGraded: string | null, atEnd: boolean) => {
    if (!extra.length) return;
    setItems((prev) => {
      if (!prev) return prev;
      const at = atEnd ? prev.length : Math.min(posRef.current + 1, prev.length);
      const ahead = new Set(prev.slice(posRef.current).map((it) => it.key));
      const add: ResolvedItem[] = [];
      for (const it of extra) {
        if (ahead.has(it.key)) continue;
        // o que acabou de ser avaliado só volta em seguida se for o único
        if (it.key === justGraded && prev.length > posRef.current) continue;
        ahead.add(it.key);
        add.push(it);
      }
      if (!add.length) return prev;
      return [...prev.slice(0, at), ...add, ...prev.slice(at)];
    });
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
    setItems((prev) => {
      if (!prev) return prev;
      const i = posRef.current;
      if (!prev[i]) return prev;
      const copy = [...prev];
      copy[i] = { ...prev[i], uid: nextUid() };
      return copy;
    });
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
        const fresh = (await db.cards.get(item.key)) ?? item.rec;
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
    setSummary((s) => ({
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
    setItems((prev) => {
      if (!prev) return prev;
      const it = prev[idx];
      if (!it) return prev;
      const copy = [...prev];
      copy[idx] = { ...it, rec: last.grade.prev ?? undefined, isNew: last.grade.prev == null, uid: nextUid() };
      return copy;
    });
  };

  /** Adiar / suspender / reiniciar o card em tela (só cards já vistos). */
  const onAction = async (item: ResolvedItem, action: CardAction) => {
    if (!item.rec || items?.[posRef.current]?.uid !== item.uid) return;
    let rec: CardRecord;
    try {
      if (action === "bury") rec = await buryCard(item.rec);
      else if (action === "suspend") rec = await suspendCard(item.rec);
      else rec = await forgetCard(item.rec, settings ?? undefined);
    } catch (err) {
      setFault(`Não deu para aplicar a ação (${errorText(err)}).`);
      remountCurrent();
      return;
    }
    setFault(null);
    // some da sessão: adiado/suspenso não volta (isActive); reiniciado vira novo
    seen.current.set(item.key, { ...item, rec });
    setItems((prev) => (prev ? prev.filter((it) => it.key !== item.key) : prev));
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
    if (!finished || total === 0 || doneFired.current || settledFor === total) return;
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
      doneFired.current = true;
      onDone?.(summary);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, total, recheck]);

  // Contadores à la Anki: o que ainda falta, por tipo, e não "x de N" — a fila
  // cresce e encolhe durante a sessão (cards que voltam), então N mentiria.
  const remaining = useMemo(() => {
    const r = { new: 0, learning: 0, review: 0 };
    if (items) for (const it of items.slice(pos)) r[kindOf(it)]++;
    return r;
  }, [items, pos]);
  const currentKind = current ? kindOf(current) : null;

  const faultLine = fault && (
    <p role="alert" className="mx-auto mb-4 w-full max-w-xl text-center text-[0.8125rem] text-again">
      {fault}
    </p>
  );

  const header = (
    <div className="mx-auto mb-7 w-full max-w-xl">
      <div className="mb-2 flex items-baseline justify-between gap-3 text-xs">
        <div className="flex items-baseline gap-3 tabular-nums">
          <Count n={remaining.new} label="novos" active={currentKind === "new"} />
          <Count n={remaining.learning} label="aprendendo" active={currentKind === "learning"} />
          <Count n={remaining.review} label="a revisar" active={currentKind === "review"} />
        </div>
        <div className="flex items-baseline gap-3">
          {history.length > 0 && (
            <button
              onClick={undo}
              className="inline-flex items-center gap-1 text-faint transition-colors hover:text-fg"
              title="Desfazer a última nota (Z)"
            >
              <Undo2 size={12} /> Desfazer
            </button>
          )}
          <span className="text-faint tabular-nums">{summary.reviewed} feitos</span>
        </div>
      </div>
      <ProgressBar value={summary.reviewed} max={summary.reviewed + (total - pos)} />
    </div>
  );

  if (items == null) return <LoadingScreen label="Montando sua revisão…" />;

  if (total === 0) {
    // Teto do dia estourado: as palavras desta dose existem e nunca foram
    // vistas — a fila só está vazia porque a cota acabou. Fechar a dose aqui
    // marcaria como concluída uma lição com zero palavras aprendidas, e ela
    // sumiria da trilha para sempre. Então nada de "Concluir": a dose fica
    // pendente e o aluno sai pelo X da barra de cima.
    if (heldBack > 0) {
      return (
        <div className="mx-auto max-w-lg pt-6">
          <EmptyState
            title="Você já fez suas palavras novas de hoje"
            description={`Faltam ${heldBack} ${pluralize(heldBack, "palavra", "palavras")} desta dose. Elas entram amanhã, quando a cota virar — o método é uma dose por dia. Até lá, dá para rever o vídeo ou os cards já vencidos.`}
          />
        </div>
      );
    }
    if (fault) {
      return (
        <div className="mx-auto max-w-lg pt-6">
          <EmptyState
            title="Não deu para montar a revisão"
            description={fault}
            action={<Button onClick={loadMore}>Tentar de novo</Button>}
          />
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-lg pt-6">
        <EmptyState
          title={onDone ? "Cards desta dose já revisados hoje" : "Nada para revisar agora"}
          description={
            emptyHint ??
            "Você está em dia. Os cards aparecem aqui sozinhos quando vencerem — não precisa recarregar."
          }
          action={onDone ? <Button onClick={() => onDone(summary)}>Concluir</Button> : undefined}
        />
      </div>
    );
  }

  if (finished) {
    if (settledFor !== total) return <LoadingScreen label="Conferindo a fila…" />;
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="mx-auto max-w-sm pt-14 text-center"
      >
        <div className="mx-auto grid h-9 w-9 place-items-center rounded-full border border-good/35 text-good">
          <Check size={16} strokeWidth={2.5} />
        </div>
        <h2 className="font-display mt-5 text-[1.5rem] leading-tight">Revisão concluída</h2>
        <p className="mt-2 text-sm text-muted">
          {summary.reviewed} {summary.reviewed === 1 ? "card revisado" : "cards revisados"}
          {summary.newLearned > 0 && ` · ${summary.newLearned} ${summary.newLearned === 1 ? "palavra nova" : "palavras novas"}`}
          {summary.again > 0 && ` · ${summary.again} ${summary.again === 1 ? "esquecido" : "esquecidos"}`}
        </p>
        {fault && !doneFired.current && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <p className="text-[0.8125rem] text-again">{fault}</p>
            <Button
              onClick={() => {
                setFault(null);
                setSettledFor(-1);
                setRecheck((n) => n + 1);
              }}
            >
              Conferir de novo
            </Button>
          </div>
        )}
        {onDone == null && (
          <div className="mt-6 flex flex-col items-center gap-2">
            {pending > 0 && (
              /* Venceu durante a sessão. Não emendo sozinho: reiniciar a tela
                 na cara de quem acabou de terminar seria hostil. */
              <Button onClick={loadMore}>
                Revisar mais {pending} {pending === 1 ? "card" : "cards"}
              </Button>
            )}
            <Button
              variant={pending > 0 ? "ghost" : "secondary"}
              onClick={() => window.history.back()}
            >
              Voltar
            </Button>
          </div>
        )}
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col items-center pt-2">
      {header}
      {faultLine}
      <Flashcard
        key={current!.uid}
        card={current!.card}
        rec={current!.rec}
        isNew={current!.isNew}
        settings={settings ?? undefined}
        mediaUrl={current!.mediaUrl}
        wordAudioUrl={current!.wordAudioUrl}
        fragmentUrl={current!.fragmentUrl}
        sceneUrl={current!.sceneUrl}
        onGrade={(rating, elapsed) => onGrade(current!, rating, elapsed)}
        onAction={current!.rec ? (a) => onAction(current!, a) : undefined}
      />
    </div>
  );
}

function Count({ n, label, active }: { n: number; label: string; active: boolean }) {
  return (
    <span className={cn("transition-colors", active ? "text-fg" : "text-faint")} title={label}>
      <span className={cn("font-semibold", active ? "text-fg" : "text-muted")}>{n}</span>{" "}
      {label}
    </span>
  );
}
