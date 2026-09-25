import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, BookOpen, Play, GalleryVerticalEnd } from "lucide-react";
import { loadIndex, loadCourse, loadDose } from "@/lib/content";
import { useAsync, useDocumentTitle } from "@/lib/hooks";
import { useApp } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { BRAND } from "@/lib/brand";
import { Logo } from "@/components/ui/Logo";
import { Button, Card, SectionLabel } from "@/components/ui/primitives";
import { DoseLine } from "@/components/ui/DoseLine";
import { LoadingScreen, ErrorScreen } from "@/components/ui/feedback";

// Sem "01 / 02 / 03": o ícone de cada fase é o mesmo que o app usa (a revisão
// tem o ícone da barra lateral), então a lista já ensina a interface.
const PHASES = [
  {
    title: "Prime",
    icon: <BookOpen size={17} strokeWidth={1.75} />,
    text: "Um preview em português ativa o contexto antes de você ouvir qualquer coisa.",
  },
  {
    title: "Imersão",
    icon: <Play size={17} strokeWidth={1.75} />,
    text: "Vídeo nativo real, no seu nível, com as legendas sob o seu controle.",
  },
  {
    title: "Revisão",
    icon: <GalleryVerticalEnd size={17} strokeWidth={1.75} />,
    text: "As palavras mais frequentes da dose viram flashcards com repetição espaçada.",
  },
];

export function Onboarding() {
  useDocumentTitle("Comece agora · " + BRAND.name);
  const nav = useNavigate();
  const { setActiveLanguage, setOnboardingDone } = useApp();
  const authStatus = useAuth((s) => s.status);
  const { data: index, loading, error, reload } = useAsync(() => loadIndex(true), []);

  // Amostra da primeira lição do primeiro idioma. Falhou? A tela segue sem ela.
  // (Fica antes de qualquer `return` — hook não pode rodar condicionalmente.)
  const { data: sample } = useAsync(async () => {
    const first = (await loadIndex()).languages[0];
    if (!first) return null;
    const course = await loadCourse(first.coursePath);
    const ref = [...course.doses].sort((a, b) => a.lessonNumber - b.lessonNumber)[0];
    if (!ref) return null;
    const dose = await loadDose(first.code, ref.path);
    const segment = dose.segments.find((s) => s.translation) ?? dose.segments[0];
    return segment ? { segment, title: dose.title, language: first.name } : null;
  }, []);

  if (loading) return <LoadingScreen label="Preparando o Imersa…" />;
  if (error) return <ErrorScreen message={error.message} onRetry={reload} />;

  const languages = index?.languages ?? [];

  const choose = (code: string) => {
    setActiveLanguage(code);
    setOnboardingDone(true);
    // quem chega pela primeira vez cria a conta em seguida (o porteiro mandaria
    // para "entrar"; aqui o padrão é "criar", que é o caso de quem é novo)
    nav(authStatus === "anon" ? "/criar-conta" : "/", { replace: true });
  };

  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl px-6 py-12 md:py-20">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Logo />
        {/* A ênfase é o itálico da serifa — a mesma voz da tradução no app
            inteiro — e não a cor da marca pintando metade do título. */}
        <h1 className="font-display mt-12 text-[2.5rem] font-normal leading-[1.08] tracking-[-0.015em] md:text-[3.25rem]">
          Aprenda um idioma com <em className="font-normal">doses diárias de imersão</em>.
        </h1>
        <p className="mt-5 max-w-[54ch] text-lg leading-relaxed text-muted">
          Conteúdo nativo no nível certo, todos os dias. Os flashcards saem da própria
          imersão — nada de listas genéricas de vocabulário.
        </p>

        {/* Mostrar em vez de prometer: a primeira fala da lição 1, com o minuto
            em que ela acontece no vídeo. É exatamente o que o app entrega. */}
        {sample && (
          <div className="mt-9 border-y border-line py-5">
            <DoseLine
              size="lg"
              startMs={sample.segment.startMs}
              target={sample.segment.target}
              translation={sample.segment.translation}
            />
            <p className="mt-3 pl-14 text-xs text-faint">
              Primeira fala de “{sample.title}” — a lição 1 de {sample.language}.
            </p>
          </div>
        )}
      </motion.div>

      <div className="mt-14">
        <SectionLabel>Como funciona uma dose</SectionLabel>
        <ol className="mt-5 flex flex-col">
          {PHASES.map((p, i) => (
            <motion.li
              key={p.title}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.06 * i }}
              className="flex gap-5 border-t border-line py-5 last:border-b"
            >
              <span className="w-5 shrink-0 pt-0.5 text-faint" aria-hidden>
                {p.icon}
              </span>
              <div className="min-w-0">
                <h3 className="font-display text-lg leading-none">{p.title}</h3>
                <p className="mt-2 max-w-[52ch] text-sm leading-relaxed text-muted">{p.text}</p>
              </div>
            </motion.li>
          ))}
        </ol>
      </div>

      <div className="mt-14">
        <SectionLabel>Escolha seu idioma</SectionLabel>
        {languages.length === 0 ? (
          <Card className="mt-4 px-5 py-5 text-sm leading-relaxed text-muted">
            Nenhum idioma disponível ainda. Gere conteúdo com a fábrica de doses (
            <code className="rounded bg-surface-2 px-1 py-0.5 text-brand">pipeline/</code>) e
            recarregue.
          </Card>
        ) : (
          <ul className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface">
            {languages.map((lang, i) => (
              <li key={lang.code} className={i > 0 ? "border-t border-line" : undefined}>
                <button
                  onClick={() => choose(lang.code)}
                  className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-2"
                >
                  {/* o idioma se apresenta na própria escrita — sem bandeira */}
                  <span className="font-target w-16 shrink-0 text-lg text-fg">
                    {lang.nativeName}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{lang.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-faint">
                    {lang.doseCount} {lang.doseCount === 1 ? "dose" : "doses"}
                  </span>
                  <ArrowRight size={16} className="shrink-0 text-faint" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {languages.length > 0 && (
        <div className="mt-8">
          <Button size="lg" onClick={() => choose(languages[0].code)}>
            Começar com {languages[0].name} <ArrowRight size={16} />
          </Button>
        </div>
      )}
    </div>
  );
}
