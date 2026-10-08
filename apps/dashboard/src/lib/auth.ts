import { API_BASE, ORCHESTRATOR_URL } from './config';

export interface LoginUser {
  id: string;
  displayName: string;
  role: string;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  publicUrl: boolean;
  /** Who can sign in (login screen). */
  users: LoginUser[];
  /** The signed-in user. */
  me: LoginUser | null;
}

/** Fired when the server answered 401 to a normal API call (session expired / signed out elsewhere). */
export const AUTH_REQUIRED_EVENT = 'lds-auth-required';

/**
 * Sends the session cookie with every call to our API (needed when the dashboard runs on another port in dev) and
 * announces 401s so the app can show the sign-in screen. Installed once, before the first render.
 */
export function installAuthFetch(): void {
  const original = window.fetch.bind(window);
  const isOurs = (url: string) => url.startsWith(API_BASE) || (ORCHESTRATOR_URL !== '' && url.startsWith(ORCHESTRATOR_URL));
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!isOurs(url)) return original(input, init);
    const res = await original(input, { credentials: 'include', ...init });
    if (res.status === 401 && !url.includes('/auth/')) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    return res;
  };
}

async function post<T>(path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(`${API_BASE}/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, status: res.status, data };
}

export const authApi = {
  status: (): Promise<AuthStatus> => fetch(`${API_BASE}/auth/status`, { cache: 'no-store' }).then((r) => r.json() as Promise<AuthStatus>),
  setup: (password: string) => post<unknown>('setup', { password }),
  login: (user: string, password: string) => post<unknown>('login', { user, password }),
  logout: () => post<unknown>('logout'),
  changePassword: (current: string, next: string) => post<unknown>('password', { current, next }),
  signOutEverywhere: () => post<unknown>('sign-out-everywhere'),
};

async function send<T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const res = await fetch(`${API_BASE}/auth/${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, data: (await res.json().catch(() => ({}))) as T & { error?: string } };
}

/** Managers (operator/admin): who has a password, and set / remove other people's. */
export const passwordsApi = {
  overview: (): Promise<{ id: string; hasPassword: boolean }[]> =>
    fetch(`${API_BASE}/auth/passwords`, { cache: 'no-store' }).then((r) => (r.ok ? (r.json() as Promise<{ id: string; hasPassword: boolean }[]>) : []))
      .catch(() => []),
  set: (userId: string, password: string) => send<unknown>('PUT', `users/${encodeURIComponent(userId)}/password`, { password }),
  remove: (userId: string) => send<unknown>('DELETE', `users/${encodeURIComponent(userId)}/password`),
};
