import { NavLink } from "react-router-dom";
import { Home, Layers, BarChart3, SlidersHorizontal, Moon, Sun, GalleryVerticalEnd, ChevronDown, CircleUser, LogIn } from "lucide-react";
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
  icon: ReactNode;
  badgeKey?: "due";
}

const NAV: NavItem[] = [
  { to: "/", label: "Hoje", icon: <Home size={16} /> },
  { to: "/review", label: "Revisão", icon: <GalleryVerticalEnd size={16} />, badgeKey: "due" },
  { to: "/library", label: "Biblioteca", icon: <Layers size={16} /> },
  { to: "/progress", label: "Progresso", icon: <BarChart3 size={16} /> },
  { to: "/settings", label: "Ajustes", icon: <SlidersHorizontal size={16} /> },
];

function ThemeToggle() {
  // O tema é aplicado ao <html> pelo efeito em App.tsx; aqui só alternamos.
  const theme = useApp((s) => s.theme);
  const toggleTheme = useApp((s) => s.toggleTheme);
  return (
    <button
      onClick={toggleTheme}
      className="grid h-8 w-8 place-items-center rounded-lg text-faint transition-colors hover:bg-surface-2 hover:text-fg"
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
    return (
      <span className="absolute right-1/2 top-0.5 h-1.5 w-1.5 translate-x-3 rounded-full bg-brand" />
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
function LanguageSwitch() {
  const lang = useApp((s) => s.activeLanguage);
  const setLang = useApp((s) => s.setActiveLanguage);
  const { data } = useAsync(() => loadIndex(), []);
  const langs = data?.languages ?? [];
  const current = langs.find((l) => l.code === lang) ?? langs[0];
  if (!current) return null;
  if (langs.length === 1) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-line px-2.5 py-2 text-sm">
        <span className="font-target">{current.nativeName}</span>
        <span className="text-[0.6875rem] text-faint">{current.name}</span>
      </div>
    );
  }
  return (
    <label className="relative flex items-center rounded-lg border border-line text-sm transition-colors hover:border-line-strong">
      <span className="font-target pointer-events-none px-2.5 py-2">{current.nativeName}</span>
      <ChevronDown size={14} className="pointer-events-none ml-auto mr-2.5 text-faint" />
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
      <aside className="sticky top-0 hidden h-dvh w-[184px] shrink-0 flex-col border-r border-line px-3 py-6 md:flex">
        <div className="px-2.5">
          <Logo />
        </div>
        <nav className="mt-8 flex flex-col gap-0.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-surface-2 font-semibold text-fg"
                    : "font-medium text-muted hover:bg-surface-2/60 hover:text-fg",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className={isActive ? "text-brand" : "text-faint"}>{item.icon}</span>
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
      <main className="min-w-0 flex-1 px-5 pb-24 pt-16 md:px-9 md:pb-14 md:pt-8">{children}</main>

      {/* Barra inferior (mobile) */}
      <nav className="frosted pb-safe fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-line md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "relative flex flex-1 flex-col items-center gap-1 py-2 text-[0.625rem] font-medium transition-colors",
                isActive ? "text-fg" : "text-faint",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute inset-x-4 top-0 h-px bg-brand" />}
                <span className={isActive ? "text-brand" : undefined}>{item.icon}</span>
                {item.label}
                {item.badgeKey === "due" && <DueBadge compact />}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Barra superior (mobile) */}
      <header className="frosted pt-safe fixed inset-x-0 top-0 z-30 flex items-center justify-between border-b border-line px-5 py-2.5 md:hidden">
        <div className="flex items-center gap-2">
          <LogoMark size={20} />
          <span className="font-display text-base leading-none">Imersa</span>
        </div>
        <ThemeToggle />
      </header>
    </div>
  );
}
