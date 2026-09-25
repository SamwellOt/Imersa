// Conta do aluno: cadastro, entrar, sair — e o que isso faz com o progresso
// que já está neste aparelho.
//
// O app continua offline-first: a sessão (token) mora no IndexedDB, em chave
// `local:` (não sincroniza, não sai no backup), e vale sem rede. O servidor só
// é consultado ao entrar/sair e no sync (lib/sync.ts usa o token como
// credencial; a conta é dona de um espaço no servidor — ver server/auth-store.mjs).
//
// Regra de ouro ao trocar de conta: o progresso deste aparelho pertence a UMA
// conta (`local:dataOwner`). Entrar com outra limpa antes — senão as revisões
// de um aluno subiriam para a conta do outro na primeira sincronização.
import { create } from "zustand";
import {
  db, getSetting, setSetting, wipeLocalData, localProgressSummary,
  AUTH_KEY, DATA_OWNER_KEY, LOCAL_SETTING,
} from "./db";
import { deviceId, resetSyncState, syncNow, SESSION_EXPIRED_EVENT } from "./sync";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: number;
}

export interface SessionInfo {
  id: string;
  device: string | null;
  agent: string | null;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

/**
 *  loading → ainda não lemos o IndexedDB (só durante a subida do app)
 *  anon    → nunca decidiu: a tela de entrar aparece
 *  guest   → escolheu seguir sem conta: o progresso fica só aqui
 *  signed  → logado (com ou sem rede)
 */
export type AuthStatus = "loading" | "anon" | "guest" | "signed";

type AuthRecord =
  | { guest: true }
  | { token: string; sessionId: string; user: AuthUser };

interface AuthState {
  status: AuthStatus;
  user: AuthUser | null;
  sessionId: string | null;
  /** Mensagem para a tela de entrar (ex.: "sessão expirada"). Some ao ser lida. */
  notice: string | null;
  set: (patch: Partial<AuthState>) => void;
}

export const useAuth = create<AuthState>()((set) => ({
  status: "loading",
  user: null,
  sessionId: null,
  notice: null,
  set: (patch) => set(patch),
}));

const apply = (rec: AuthRecord | null) => {
  if (!rec) useAuth.getState().set({ status: "anon", user: null, sessionId: null });
  else if ("guest" in rec) useAuth.getState().set({ status: "guest", user: null, sessionId: null });
  else useAuth.getState().set({ status: "signed", user: rec.user, sessionId: rec.sessionId });
};

const readRecord = () => getSetting<AuthRecord | null>(AUTH_KEY, null);

/** Lê a sessão guardada. Chamado uma vez, antes de montar o app. */
export async function hydrateAuth(): Promise<AuthStatus> {
  apply(await readRecord());
  return useAuth.getState().status;
}

export const authToken = async () => {
  const rec = await readRecord();
  return rec && "token" in rec ? rec.token : null;
};

// ---- chamadas ao servidor ----

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, body?: unknown, opts: { auth?: boolean; keepalive?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.auth !== false) {
    const token = await authToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: opts.keepalive,
    });
  } catch {
    throw new ApiError(0, "Sem conexão com o servidor. Verifique a rede e tente de novo.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new ApiError(res.status, data.error || `O servidor respondeu ${res.status}.`);
  return data;
}

interface SessionResponse {
  user: AuthUser;
  token: string;
  sessionId: string;
}

export interface EnterOptions {
  /** Levar o progresso que já está neste aparelho para a conta (só faz sentido
   *  quando ele ainda não pertence a conta nenhuma). */
  keepLocal: boolean;
}

/**
 * Depois de o servidor aceitar: decide o que fazer com o progresso local e
 * guarda a sessão. Três casos:
 *   • o progresso já é DESTA conta (sessão tinha expirado): mantém tudo, inclusive
 *     o cursor do sync;
 *   • é de OUTRA conta: limpa — ele continua inteiro na conta dele no servidor;
 *   • não é de ninguém (anônimo/convidado): leva para a conta (`keepLocal`) —
 *     sobe tudo na primeira sincronização — ou limpa e começa do que a conta tem.
 */
async function adopt(r: SessionResponse, opts: EnterOptions): Promise<void> {
  const owner = await getSetting<string>(DATA_OWNER_KEY, "");
  if (owner !== r.user.id) {
    if (owner || !opts.keepLocal) await wipeLocalData();
    await resetSyncState();
  }
  await setSetting(DATA_OWNER_KEY, r.user.id);
  await setSetting(AUTH_KEY, { token: r.token, sessionId: r.sessionId, user: r.user } satisfies AuthRecord);
  apply({ token: r.token, sessionId: r.sessionId, user: r.user });
  void syncNow();
}

export async function register(
  input: { email: string; password: string; name: string },
  opts: EnterOptions,
): Promise<AuthUser> {
  const r = await api<SessionResponse>("/api/auth/register", { ...input, deviceId: await deviceId() }, { auth: false });
  await adopt(r, opts);
  return r.user;
}

export async function login(
  input: { email: string; password: string },
  opts: EnterOptions,
): Promise<AuthUser> {
  const r = await api<SessionResponse>("/api/auth/login", { ...input, deviceId: await deviceId() }, { auth: false });
  await adopt(r, opts);
  return r.user;
}

export async function continueAsGuest(): Promise<void> {
  await setSetting(AUTH_KEY, { guest: true } satisfies AuthRecord);
  apply({ guest: true });
}

/** Há algo estudado aqui que ainda não subiu? (para avisar antes de sair) */
export async function hasUnsyncedChanges(): Promise<boolean> {
  const state = await getSetting<{ pushedAt: number }>(`${LOCAL_SETTING}syncState`, { pushedAt: 0 });
  const since = state.pushedAt;
  // as mesmas tabelas que o sync sobe (`localChanges`): «não entendi» e ajustes
  // ficavam de fora e sumiam sem aviso ao sair offline
  const [c, p, r, i, t, m, s] = await Promise.all([
    db.cards.where("updatedAt").above(since).count(),
    db.doseProgress.where("updatedAt").above(since).count(),
    db.reviewLog.where("reviewedAt").above(since).count(),
    db.immersionLog.where("at").above(since).count(),
    db.tombstones.count(),
    db.lineMarks.where("at").above(since).count(),
    db.settings.filter((x) => !x.key.startsWith(LOCAL_SETTING) && (x.updatedAt ?? 0) > since).count(),
  ]);
  return c + p + r + i + t + m + s > 0;
}

/**
 * Sai da conta. Primeiro entrega o que falta ao servidor; se não der (sem
 * rede) e houver algo pendente, recusa com `pending` — a tela pergunta se o
 * aluno quer sair mesmo assim, perdendo o que não subiu. Depois esvazia o
 * progresso deste aparelho (a conta fica inteira no servidor).
 */
export async function logout({ force = false } = {}): Promise<void> {
  const r = await syncNow();
  if (!r.ok && !force && (await hasUnsyncedChanges())) {
    throw new ApiError(0, "pending");
  }
  // melhor esforço: sem rede a sessão morre sozinha em 180 dias
  await api("/api/auth/logout", {}, { keepalive: true }).catch(() => {});
  await wipeLocalData();
  apply(null);
}

/** O servidor recusou a sessão: cai para "anon" mas PRESERVA o progresso — ele
 *  continua sendo desta conta (`dataOwner`), e entrar de novo retoma de onde estava. */
export async function sessionExpired(): Promise<void> {
  const rec = await readRecord();
  if (!rec || !("token" in rec)) return;
  await db.settings.delete(AUTH_KEY);
  apply(null);
  useAuth.getState().set({ notice: "Sua sessão expirou. Entre de novo para continuar sincronizando." });
}

if (typeof addEventListener === "function") {
  addEventListener(SESSION_EXPIRED_EVENT, () => void sessionExpired());
}

// ---- gestão da conta (Ajustes) ----

export interface MeResponse {
  user: AuthUser;
  sessionId: string;
  sessions: SessionInfo[];
  stats: Record<string, number>;
}

export async function fetchMe(): Promise<MeResponse> {
  try {
    const me = await api<MeResponse>("/api/auth/me");
    // nome pode ter mudado em outro aparelho
    const rec = await readRecord();
    if (rec && "token" in rec && (rec.user.name !== me.user.name || rec.user.email !== me.user.email)) {
      await setSetting(AUTH_KEY, { ...rec, user: me.user });
      useAuth.getState().set({ user: me.user });
    }
    return me;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) await sessionExpired();
    throw e;
  }
}

export async function revokeSession(id: string): Promise<SessionInfo[]> {
  const r = await api<{ sessions: SessionInfo[] }>("/api/auth/sessions/revoke", { id });
  return r.sessions;
}

export async function revokeOtherSessions(): Promise<SessionInfo[]> {
  const r = await api<{ sessions: SessionInfo[] }>("/api/auth/sessions/revoke", { others: true });
  return r.sessions;
}

export async function changePassword(current: string, next: string): Promise<void> {
  await api("/api/auth/password", { current, next });
}

export async function renameUser(name: string): Promise<AuthUser> {
  const r = await api<{ user: AuthUser }>("/api/auth/profile", { name });
  const rec = await readRecord();
  if (rec && "token" in rec) await setSetting(AUTH_KEY, { ...rec, user: r.user });
  useAuth.getState().set({ user: r.user });
  return r.user;
}

/** Apaga a conta no servidor e o progresso deste aparelho. */
export async function deleteAccount(password: string): Promise<void> {
  await api("/api/auth/delete", { password });
  await wipeLocalData();
  apply(null);
}

/**
 * Progresso que a tela de entrar pode oferecer para "levar para a conta": só o
 * que ainda não pertence a conta nenhuma. Depois de uma sessão expirar o
 * progresso continua sendo da conta (`dataOwner`) e a oferta não faz sentido.
 */
export async function unownedLocalProgress(): Promise<{ cards: number; reviews: number } | null> {
  const owner = await getSetting<string>(DATA_OWNER_KEY, "");
  if (owner) return null;
  const sum = await localProgressSummary();
  return sum.cards > 0 || sum.reviews > 0 ? sum : null;
}

// ---- apresentação ----

export const firstName = (u: AuthUser | null) =>
  (u?.name || "").trim().split(/\s+/)[0] || "";

/** "Chrome · Linux", "Safari · iPhone" — o bastante para reconhecer o aparelho. */
export function describeAgent(ua: string | null): string {
  if (!ua) return "Aparelho";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /curl\//.test(ua) ? "curl"
    : "Navegador";
  const os = /iPhone/.test(ua) ? "iPhone"
    : /iPad/.test(ua) ? "iPad"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X/.test(ua) ? "Mac"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} · ${os}` : browser;
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? "ontem" : `há ${d} dias`;
  return new Date(ms).toLocaleDateString("pt-BR", { day: "numeric", month: "short" });
}
