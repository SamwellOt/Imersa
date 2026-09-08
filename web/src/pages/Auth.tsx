import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { Button } from "@/components/ui/primitives";
import { Spinner } from "@/components/ui/feedback";
import { useDocumentTitle } from "@/lib/hooks";
import { BRAND } from "@/lib/brand";
import { cn, pluralize } from "@/lib/utils";
import {
  ApiError, continueAsGuest, unownedLocalProgress, login, register, useAuth,
} from "@/lib/auth";

export const MIN_PASSWORD = 8;

/** Campo de formulário: rótulo pequeno em cima, borda que acende no foco. */
function Field({
  label, hint, error, children,
}: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className="text-xs font-medium text-muted">{label}</label>
        {hint && <span className="text-[0.6875rem] text-faint">{hint}</span>}
      </div>
      <div className="mt-1.5">{children(id)}</div>
      {error && <p className="mt-1.5 text-xs text-again">{error}</p>}
    </div>
  );
}

const inputCls =
  "h-11 w-full rounded-lg border border-line bg-surface px-3.5 text-[0.9375rem] text-fg outline-none transition-colors placeholder:text-faint focus:border-brand aria-[invalid=true]:border-again";

function PasswordInput({
  id, value, onChange, autoComplete, invalid,
}: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        aria-invalid={invalid}
        required
        minLength={MIN_PASSWORD}
        className={cn(inputCls, "pr-11")}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Ocultar senha" : "Mostrar senha"}
        className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-fg"
      >
        {show ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

export function Auth({ mode }: { mode: "login" | "register" }) {
  const isRegister = mode === "register";
  useDocumentTitle((isRegister ? "Criar conta" : "Entrar") + " · " + BRAND.name);
  const nav = useNavigate();
  const loc = useLocation();
  const status = useAuth((s) => s.status);
  // a mensagem (ex.: sessão expirada) é lida uma vez no mount e some do store —
  // num efeito ela sumia antes de aparecer, porque o efeito roda logo após o render
  const [notice] = useState(() => useAuth.getState().notice);
  const next = new URLSearchParams(loc.search).get("next") || "/";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [keepLocal, setKeepLocal] = useState(true);
  const [local, setLocal] = useState<{ cards: number; reviews: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<"email" | "password" | null>(null);

  useEffect(() => {
    unownedLocalProgress().then(setLocal);
  }, []);
  useEffect(() => {
    if (notice) useAuth.getState().set({ notice: null });
  }, [notice]);
  useEffect(() => {
    setError(null);
    setFieldError(null);
  }, [mode]);

  if (status === "signed") return <Navigate to={next} replace />;

  // Só oferece "levar o progresso" quando existe progresso e ele ainda é de
  // ninguém (`unownedLocalProgress`) — depois de sair o aparelho fica vazio.
  const hasLocal = !!local;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setFieldError(null);
    const em = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) {
      setFieldError("email");
      setError("Informe um e-mail válido.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setFieldError("password");
      setError(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
      return;
    }
    setBusy(true);
    try {
      const opts = { keepLocal: hasLocal && keepLocal };
      if (isRegister) await register({ email: em, password, name: name.trim() }, opts);
      else await login({ email: em, password }, opts);
      nav(next, { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Não deu certo. Tente de novo.";
      if (err instanceof ApiError && err.status === 401) setFieldError("password");
      if (err instanceof ApiError && err.status === 409) setFieldError("email");
      setError(msg);
      setBusy(false);
    }
  };

  const guest = async () => {
    await continueAsGuest();
    nav(next, { replace: true });
  };

  const switchTo = isRegister ? "/entrar" : "/criar-conta";
  const switchSearch = loc.search;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col px-6 py-10 md:py-16">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex-1">
        <Logo />
        <h1 className="font-display mt-10 text-[2rem] leading-[1.15]">
          {isRegister ? "Crie sua conta." : "Bem-vindo de volta."}
        </h1>
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted">
          {isRegister
            ? "Seu progresso passa a viver na conta: desktop e celular veem as mesmas revisões, e nada se perde se você trocar de aparelho."
            : "Entre para retomar suas revisões de onde parou, em qualquer aparelho."}
        </p>

        {notice && (
          <p className="mt-6 rounded-lg border border-line bg-surface px-3.5 py-2.5 text-sm text-muted">
            {notice}
          </p>
        )}

        <form onSubmit={submit} noValidate className="mt-8 flex flex-col gap-5">
          {isRegister && (
            <Field label="Nome" hint="opcional">
              {(id) => (
                <input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  placeholder="Como quer ser chamado"
                  className={inputCls}
                />
              )}
            </Field>
          )}
          <Field label="E-mail">
            {(id) => (
              <input
                id={id}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                autoFocus={!isRegister}
                aria-invalid={fieldError === "email"}
                className={inputCls}
              />
            )}
          </Field>
          <Field label="Senha" hint={isRegister ? `mínimo ${MIN_PASSWORD} caracteres` : undefined}>
            {(id) => (
              <PasswordInput
                id={id}
                value={password}
                onChange={setPassword}
                autoComplete={isRegister ? "new-password" : "current-password"}
                invalid={fieldError === "password"}
              />
            )}
          </Field>

          {hasLocal && local && (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-surface px-3.5 py-3">
              <input
                type="checkbox"
                checked={keepLocal}
                onChange={(e) => setKeepLocal(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
              />
              <span className="text-sm leading-snug">
                <span className="block font-medium">Levar o progresso deste aparelho para a conta</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                  {local.cards} {pluralize(local.cards, "palavra", "palavras")} e {local.reviews}{" "}
                  {pluralize(local.reviews, "revisão", "revisões")} feitas aqui sem conta.
                  Desmarcado, o aparelho começa do que a conta já tem.
                </span>
              </span>
            </label>
          )}

          {error && (
            <p role="alert" className="text-sm leading-relaxed text-again">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" block disabled={busy} className="mt-1">
            {busy ? <Spinner className="border-brand-fg/30 border-t-brand-fg" /> : null}
            {busy ? (isRegister ? "Criando conta…" : "Entrando…") : isRegister ? "Criar conta" : "Entrar"}
            {!busy && <ArrowRight size={16} />}
          </Button>
        </form>

        <p className="mt-6 text-sm text-muted">
          {isRegister ? "Já tem conta? " : "Ainda não tem conta? "}
          <Link
            to={switchTo + switchSearch}
            replace
            className="font-medium text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-brand"
          >
            {isRegister ? "Entrar" : "Criar uma"}
          </Link>
        </p>
      </motion.div>

      {status !== "guest" && (
        <div className="mt-12 border-t border-line pt-5">
          <button
            onClick={guest}
            className="text-sm text-faint transition-colors hover:text-fg"
          >
            Continuar sem conta
          </button>
          <p className="mt-1.5 max-w-[40ch] text-xs leading-relaxed text-faint">
            O progresso fica só neste navegador. Dá para criar a conta depois, em Ajustes, e levar
            tudo junto.
          </p>
        </div>
      )}
    </div>
  );
}
