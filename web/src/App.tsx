import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import { Onboarding } from "@/pages/Onboarding";
import { Dashboard } from "@/pages/Dashboard";
import { DosePlayer } from "@/pages/DosePlayer";
import { Review } from "@/pages/Review";
import { Library } from "@/pages/Library";
import { Progress } from "@/pages/Progress";
import { Settings } from "@/pages/Settings";
import { Auth } from "@/pages/Auth";
import { applyTheme, useApp } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import type { ReactNode } from "react";

/**
 * Porteiro das telas do app: primeiro o onboarding (idioma), depois a conta.
 * Quem ainda não decidiu ("anon") vai para /entrar — quem escolheu seguir sem
 * conta ("guest") ou já entrou passa. A sessão vale offline: o servidor não é
 * consultado aqui.
 */
function RequireOnboarding({ children }: { children: ReactNode }) {
  const onboardingDone = useApp((s) => s.onboardingDone);
  const activeLanguage = useApp((s) => s.activeLanguage);
  const status = useAuth((s) => s.status);
  const loc = useLocation();
  if (!onboardingDone || !activeLanguage) {
    return <Navigate to="/onboarding" replace state={{ from: loc.pathname }} />;
  }
  if (status === "anon") {
    const next = loc.pathname + loc.search;
    return <Navigate to={`/entrar${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`} replace />;
  }
  return <>{children}</>;
}

/**
 * A dose é remontada quando o `:doseId` muda. Sem a `key`, "Próxima dose" trocava
 * o id mas o React reaproveitava o componente — e a lição seguinte abria presa
 * na fase "fim" (com o resumo da anterior), porque a fase mora em `useState`.
 */
function DoseRoute() {
  const { doseId } = useParams();
  return <DosePlayer key={doseId} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <RequireOnboarding>
      <AppShell>{children}</AppShell>
    </RequireOnboarding>
  );
}

export default function App() {
  const theme = useApp((s) => s.theme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/entrar" element={<Auth mode="login" />} />
        <Route path="/criar-conta" element={<Auth mode="register" />} />

        {/* Full-screen focused flows (no shell) */}
        <Route
          path="/dose/:doseId"
          element={
            <RequireOnboarding>
              <DoseRoute />
            </RequireOnboarding>
          }
        />
        <Route
          path="/review"
          element={
            <RequireOnboarding>
              <Review />
            </RequireOnboarding>
          }
        />

        {/* Shell pages */}
        <Route path="/" element={<Shell><Dashboard /></Shell>} />
        <Route path="/library" element={<Shell><Library /></Shell>} />
        <Route path="/progress" element={<Shell><Progress /></Shell>} />
        <Route path="/settings" element={<Shell><Settings /></Shell>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
