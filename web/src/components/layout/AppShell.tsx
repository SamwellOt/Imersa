import { NavLink } from "react-router-dom";
import { Home, Layers, BarChart3, SlidersHorizontal, Moon, Sun, GalleryVerticalEnd, ChevronDown, CircleUser, LogIn, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Logo, LogoMark } from "@/components/ui/Logo";
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/store";
import { useDueCount } from "@/lib/useDue";
import { useAsync } from "@/lib/hooks";
import { loadIndex } from "@/lib/content";
import { useAuth } from "@/lib/auth";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  badgeKey?: "due";
}

const NAV: NavItem[] = [
  { to: "/", label: "Hoje", icon: Home },
  { to: "/review", label: "Revisão", icon: GalleryVerticalEnd, badgeKey: "due" },
  { to: "/library", label: "Biblioteca", icon: Layers },
  { to: "/progress", label: "Progresso", icon: BarChart3 },
  { to: "/settings", label: "Ajustes", icon: SlidersHorizontal },
];

function ThemeToggle() {
  // O tema é aplicado ao <html> pelo efeito em App.tsx; aqui só alternamos.
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  return (
    <button
      onClick={toggleTheme}
      className="grid h-10 w-10 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg md:h-8 md:w-8"
      aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
      title={theme === "dark" ? "Tema claro" : "Tema escuro"}
    >
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

function DueBadge({ compact }: { compact?: boolean }) {
  const lang = useApp((s) => s.activeLanguage);
  const due = useDueCount(lang);
  if (!due) return null;
  if (compact) {
    // no celular o número também: um ponto sozinho não dizia quanto falta
    return (
      <span className="absolute left-1/2 top-1 ml-2 min-w-[1.125rem] rounded-full bg-brand px-1 text-center text-[0.625rem] font-semibold leading-[1.125rem] tabular-nums text-brand-fg">
        {due > 99 ? "99+" : due}
      </span>
    );
  }
  return (
    <span className="ml-auto rounded-md bg-brand-soft px-1.5 py-0.5 text-[0.6875rem] font-semibold tabular-nums text-brand">
      {due > 99 ? "99+" : due}
    </span>
  );
}

/**
 * O idioma mora na barra lateral, escrito na própria língua (한국어 / 日本語) —
 * antes só a Biblioteca trocava. Um idioma só: mostra sem o seletor.
 */
function LanguageSwitch({ compact }: { compact?: boolean }) {
  const lang = useApp((s) => s.activeLanguage);
  const setLang = useApp((s) => s.setActiveLanguage);
  const { data } = useAsync(() => loadIndex(), []);
  const langs = data?.languages ?? [];
  const current = langs.find((l) => l.code === lang) ?? langs[0];
  if (!current) return null;
  // Uma linha de texto, não um campo de formulário: o idioma na própria escrita
  // em cima, o nome em PT embaixo. O <select> fica invisível por cima.
  const face = (
    <span className="min-w-0 flex-1">
      <span className="font-target block text-[0.9375rem] leading-tight text-fg">{current.nativeName}</span>
      <span className="block text-[0.6875rem] leading-tight text-faint">{current.name}</span>
    </span>
  );
  if (langs.length === 1) {
    return compact ? null : <div className="flex items-center px-2 py-2">{face}</div>;
  }
  const select = (
    <select
      aria-label="Idioma"
      value={current.code}
      onChange={(e) => setLang(e.target.value)}
      className="absolute inset-0 cursor-pointer opacity-0"
    >
      {langs.map((l) => (
        <option key={l.code} value={l.code}>
          {l.nativeName} · {l.name}
        </option>
      ))}
    </select>
  );
  // Barra de cima do celular: só o idioma na própria escrita. Antes a troca de
  // idioma só existia na barra lateral do desktop — no celular não havia como.
  if (compact) {
    return (
      <label className="relative flex h-10 items-center gap-1 rounded-lg px-2.5 transition-colors hover:bg-surface-2/60">
        <span className="font-target text-[0.9375rem] text-fg">{current.nativeName}</span>
        <ChevronDown size={14} className="pointer-events-none text-faint" />
        {select}
      </label>
    );
  }
  return (
    <label className="relative flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2/60">
      {face}
      <ChevronDown size={14} className="pointer-events-none shrink-0 text-faint" />
      {select}
    </label>
  );
}

/**
 * A conta mora no rodapé da barra lateral: nome + e-mail, levando aos Ajustes.
 * Sem conta, um convite discreto para entrar (o progresso está só aqui).
 */
function AccountRow() {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  if (status === "signed" && user) {
    return (
      <NavLink
        to="/settings"
        className="flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2/60"
        title={user.email}
      >
        <CircleUser size={22} strokeWidth={1.5} className="shrink-0 text-faint" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium leading-tight">{user.name || user.email}</span>
          {user.name && <span className="block truncate text-[0.6875rem] text-faint">{user.email}</span>}
        </span>
      </NavLink>
    );
  }
  return (
    <NavLink
      to="/entrar?next=%2Fsettings"
      className="flex items-center gap-2.5 rounded-lg px-2 py-2 text-sm text-muted transition-colors hover:bg-surface-2/60 hover:text-fg"
    >
      <LogIn size={16} className="shrink-0 text-faint" />
      <span className="min-w-0">
        <span className="block font-medium leading-tight">Entrar</span>
        <span className="block text-[0.6875rem] text-faint">progresso só neste aparelho</span>
      </span>
    </NavLink>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1240px] overflow-x-hidden">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-dvh w-[196px] shrink-0 flex-col border-r border-line px-3 py-6 md:flex">
        <div className="px-2.5">
          <Logo />
        </div>
        {/* Item ativo: texto cheio + um traço da marca na margem esquerda, em vez
            de pílula de fundo — é a mesma linguagem de filete do resto do app. */}
        <nav className="mt-9 flex flex-col gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  isActive
                    ? "font-semibold text-fg before:absolute before:-left-3 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-r-full before:bg-brand"
                    : "font-medium text-muted hover:bg-surface-2/60 hover:text-fg",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon size={16} className={isActive ? "text-brand" : "text-faint"} />
                  {item.label}
                  {item.badgeKey === "due" && <DueBadge />}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2">
          <AccountRow />
          <LanguageSwitch />
          <div className="flex items-center justify-between pl-1">
            <span className="text-[0.6875rem] text-faint">v0.2</span>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      {/* Coluna principal */}
      <main className="min-w-0 flex-1 px-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pt-[calc(4.5rem+env(safe-area-inset-top))] md:px-9 md:pb-14 md:pt-8">{children}</main>

      {/* Barra inferior (mobile): fundo quase opaco (`.bar-solid`) — com o
          translúcido o texto da página atravessava os rótulos. Alvo de 56 px,
          ícone de 20 px e o traço da aba ativa na borda de cima. */}
      <nav aria-label="Navegação" className="bar-solid pb-safe fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-line md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "no-tap-highlight relative flex min-h-14 flex-1 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors",
                isActive ? "text-fg" : "text-muted",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute left-1/2 top-0 h-0.5 w-8 -translate-x-1/2 rounded-b-full bg-brand" />}
                <item.icon size={20} strokeWidth={isActive ? 2.25 : 1.75} className={isActive ? "text-brand" : undefined} />
                {item.label}
                {item.badgeKey === "due" && <DueBadge compact />}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Barra superior (mobile) */}
      <header className="bar-solid pt-safe fixed inset-x-0 top-0 z-30 border-b border-line md:hidden">
        <div className="flex h-14 items-center justify-between pl-5 pr-2.5">
          <div className="flex items-center gap-2">
            <LogoMark size={20} />
            <span className="font-display text-base leading-none">Imersa</span>
          </div>
          <div className="flex items-center gap-0.5">
            <LanguageSwitch compact />
            <ThemeToggle />
          </div>
        </div>
      </header>
    </div>
  );
}
