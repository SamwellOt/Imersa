import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { RefreshCw, LogOut, Monitor, Smartphone } from "lucide-react";
import { Button, Card, Divider, SectionLabel, SettingRow } from "@/components/ui/primitives";
import { Spinner } from "@/components/ui/feedback";
import { cn, pluralize } from "@/lib/utils";
import { getSyncState, onSync, syncNow, type SyncState } from "@/lib/sync";
import {
  useAuth, fetchMe, logout, revokeSession, revokeOtherSessions, changePassword, renameUser,
  deleteAccount, describeAgent, relativeTime, ApiError, type SessionInfo,
} from "@/lib/auth";
import { MIN_PASSWORD } from "@/pages/Auth";

const fieldCls =
  "h-9 w-full rounded-md border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors placeholder:text-faint focus:border-brand";

function syncLabel(state: SyncState | null): string {
  if (!state) return "";
  if (state.lastError) return `Última tentativa falhou: ${state.lastError}`;
  if (!state.lastOkAt) return "Ainda não sincronizou.";
  return `Sincronizado ${relativeTime(state.lastOkAt)}.`;
}

/** Nome editável no lugar: grava no blur/Enter, só se mudou. */
function NameField({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const commit = async () => {
    const v = draft.trim();
    if (v === value.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(v);
    } finally {
      setSaving(false);
    }
  };
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      placeholder="Seu nome"
      autoComplete="name"
      className={cn(fieldCls, "w-44")}
      disabled={saving}
    />
  );
}

function PasswordForm({ notify }: { notify: (m: string) => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < MIN_PASSWORD) {
      setError(`A senha nova precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      notify("Senha alterada. Os outros aparelhos precisarão entrar de novo.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não deu certo.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 pb-4 pt-1 sm:max-w-sm">
      <input
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        placeholder="Senha atual"
        autoComplete="current-password"
        required
        className={fieldCls}
      />
      <input
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder={`Senha nova (mínimo ${MIN_PASSWORD})`}
        autoComplete="new-password"
        required
        minLength={MIN_PASSWORD}
        className={fieldCls}
      />
      {error && <p className="text-xs text-again">{error}</p>}
      <div>
        <Button type="submit" size="sm" variant="secondary" disabled={busy || !current || !next}>
          {busy && <Spinner className="h-3 w-3" />} Alterar senha
        </Button>
      </div>
    </form>
  );
}

function DeleteForm({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!confirm("Excluir a conta apaga todo o seu progresso no servidor e neste aparelho. Não dá para desfazer. Continuar?")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAccount(password);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não deu certo.");
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2.5 pb-4 pt-1 sm:max-w-sm">
      <p className="text-xs leading-relaxed text-muted">
        Apaga a conta, as sessões e todo o progresso guardado no servidor. Exporte um backup antes, se quiser guardar.
      </p>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Confirme com a sua senha"
        autoComplete="current-password"
        required
        className={fieldCls}
      />
      {error && <p className="text-xs text-again">{error}</p>}
      <div>
        <Button type="submit" size="sm" variant="danger" disabled={busy || !password}>
          Excluir conta
        </Button>
      </div>
    </form>
  );
}

function SessionList({ sessions, onChange }: { sessions: SessionInfo[]; onChange: (s: SessionInfo[]) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const others = sessions.filter((s) => !s.current);
  const revoke = async (id: string) => {
    setBusyId(id);
    try {
      onChange(await revokeSession(id));
    } finally {
      setBusyId(null);
    }
  };
  const revokeAll = async () => {
    if (!confirm("Encerrar a sessão de todos os outros aparelhos?")) return;
    setBusyId("*");
    try {
      onChange(await revokeOtherSessions());
    } finally {
      setBusyId(null);
    }
  };
  return (
    <ul className="pb-2">
      {sessions.map((s) => {
        const label = describeAgent(s.agent);
        const mobile = /iPhone|iPad|Android/.test(label);
        return (
          <li key={s.id} className="flex items-center gap-3 py-2.5">
            <span className="text-faint">
              {mobile ? <Smartphone size={16} /> : <Monitor size={16} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm">
                <span className="truncate">{label}</span>
                {s.current && (
                  <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[0.625rem] font-semibold text-brand">
                    este aparelho
                  </span>
                )}
              </span>
              <span className="block text-xs text-faint">
                {s.current ? "ativo agora" : `visto ${relativeTime(s.lastSeenAt)}`} · desde{" "}
                {new Date(s.createdAt).toLocaleDateString("pt-BR", { day: "numeric", month: "short" })}
              </span>
            </span>
            {!s.current && (
              <Button variant="ghost" size="sm" disabled={busyId !== null} onClick={() => revoke(s.id)}>
                {busyId === s.id ? <Spinner className="h-3 w-3" /> : "Encerrar"}
              </Button>
            )}
          </li>
        );
      })}
      {others.length > 1 && (
        <li className="pt-1">
          <Button variant="ghost" size="sm" disabled={busyId !== null} onClick={revokeAll}>
            Sair dos outros {others.length} aparelhos
          </Button>
        </li>
      )}
    </ul>
  );
}

export function AccountSection({ notify }: { notify: (msg: string) => void }) {
  const nav = useNavigate();
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    getSyncState().then(setSyncState);
    return onSync(() => void getSyncState().then(setSyncState));
  }, []);

  useEffect(() => {
    if (status !== "signed") return;
    let alive = true;
    fetchMe()
      .then((me) => {
        if (!alive) return;
        setSessions(me.sessions);
        setStats(me.stats);
        setMeError(null);
      })
      .catch((e) => alive && setMeError(e instanceof ApiError && e.status === 0 ? "offline" : e.message));
    return () => {
      alive = false;
    };
  }, [status]);

  const runSyncNow = async () => {
    setSyncing(true);
    const r = await syncNow();
    setSyncing(false);
    setSyncState(await getSyncState());
    notify(r.ok ? `Sincronizado — ${r.sent} enviados, ${r.received} recebidos.` : r.error ?? "Falha ao sincronizar.");
  };

  const doLogout = async () => {
    if (!confirm("Sair da conta? O progresso sai deste aparelho e continua guardado na sua conta.")) return;
    setLeaving(true);
    try {
      try {
        await logout();
      } catch (err) {
        if (!(err instanceof ApiError && err.message === "pending")) throw err;
        if (!confirm("Sem conexão: há revisões feitas aqui que ainda não subiram para a conta. Sair agora perde essas revisões. Sair mesmo assim?")) {
          setLeaving(false);
          return;
        }
        await logout({ force: true });
      }
      nav("/entrar", { replace: true });
    } catch (err) {
      notify(err instanceof Error ? err.message : "Não consegui sair.");
      setLeaving(false);
    }
  };

  if (status !== "signed" || !user) {
    return (
      <div className="mt-9">
        <SectionLabel>Conta</SectionLabel>
        <Card className="mt-3 px-5">
          <SettingRow title="Você está sem conta" desc="O progresso fica só neste navegador. Com uma conta ele vai junto para o celular e sobrevive a trocar de aparelho.">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button size="sm" onClick={() => nav("/criar-conta?next=%2Fsettings")}>Criar conta</Button>
              <Button size="sm" variant="secondary" onClick={() => nav("/entrar?next=%2Fsettings")}>Entrar</Button>
            </div>
          </SettingRow>
        </Card>
        <p className="mt-3 max-w-[62ch] px-1 text-xs leading-relaxed text-faint">
          Ao criar a conta, o app oferece levar o que você já estudou aqui. Sem conta, use exportar/importar
          (abaixo) como backup.
        </p>
      </div>
    );
  }

  const since = new Date(user.createdAt).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const cardCount = stats?.card ?? 0;
  const reviewCount = stats?.review ?? 0;

  return (
    <div className="mt-9">
      <SectionLabel>Conta</SectionLabel>
      <Card className="mt-3 px-5">
        <SettingRow title={user.name || user.email} desc={user.name ? `${user.email} · desde ${since}` : `desde ${since}`}>
          <Button variant="secondary" size="sm" onClick={doLogout} disabled={leaving}>
            {leaving ? <Spinner className="h-3 w-3" /> : <LogOut size={14} />} Sair
          </Button>
        </SettingRow>
        <Divider />
        <SettingRow
          title="Sincronização"
          desc={[
            syncLabel(syncState),
            stats ? `Na conta: ${cardCount} ${pluralize(cardCount, "palavra", "palavras")}, ${reviewCount} ${pluralize(reviewCount, "revisão", "revisões")}.` : "",
          ].filter(Boolean).join(" ")}
        >
          <Button size="sm" variant="secondary" onClick={runSyncNow} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? "animate-spin" : undefined} />
            {syncing ? "Sincronizando…" : "Sincronizar agora"}
          </Button>
        </SettingRow>
        <Divider />
        <SettingRow title="Nome" desc="Como o app te chama no Hoje">
          <NameField
            value={user.name}
            onSave={async (v) => {
              try {
                await renameUser(v);
                notify("Nome atualizado.");
              } catch (err) {
                notify(err instanceof Error ? err.message : "Não deu certo.");
              }
            }}
          />
        </SettingRow>
        <Divider />
        <details className="py-3.5">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-fg">Alterar senha</summary>
          <PasswordForm notify={notify} />
        </details>
        <Divider />
        <div className="py-3.5">
          <div className="text-sm font-medium">Aparelhos conectados</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted">
            Cada aparelho em que você entrou tem a própria sessão. Encerre as que não reconhece.
          </div>
          {meError === "offline" ? (
            <p className="mt-3 text-xs text-faint">Sem conexão agora — a lista aparece quando a rede voltar.</p>
          ) : meError ? (
            <p className="mt-3 text-xs text-again">{meError}</p>
          ) : sessions ? (
            <SessionList sessions={sessions} onChange={setSessions} />
          ) : (
            <div className="flex items-center gap-2 py-3 text-xs text-faint"><Spinner className="h-3 w-3" /> Carregando…</div>
          )}
        </div>
        <Divider />
        <details className="py-3.5">
          <summary className="cursor-pointer text-sm font-medium text-muted hover:text-again">Excluir conta</summary>
          <DeleteForm
            onDeleted={() => {
              notify("Conta excluída.");
              nav("/entrar", { replace: true });
            }}
          />
        </details>
      </Card>
      <p className="mt-3 max-w-[62ch] px-1 text-xs leading-relaxed text-faint">
        O progresso vai e volta sozinho — ao abrir o app, ao terminar uma revisão e a cada 5 minutos.
        Sem rede, você continua estudando normalmente: o que faltou sobe na próxima vez que houver conexão.
      </p>
    </div>
  );
}
