import { useSyncExternalStore } from 'react';
import { API_BASE } from './config';
import { api } from './api';

/**
 * The page half of the browser extension's "Connect" handshake. The extension's content script (it runs only on this server's own pages) announces itself
 * with a `postMessage`; the signed-in dashboard asks the server for a one-use code and hands it over the same way. The extension then exchanges it for its
 * own token. Nothing secret is ever typed: the sign-in (password, 2FA, Cloudflare Access) is the one already open in this tab.
 */
export interface ExtensionState {
  detected: boolean;
  version: string | null;
  extensionId: string | null;
  connected: boolean;
  needsReconnect: boolean;
  user: string | null;
  busy: boolean;
  error: string | null;
}

export const INITIAL: ExtensionState = { detected: false, version: null, extensionId: null, connected: false, needsReconnect: false, user: null, busy: false, error: null };

/** One message from the extension → the new state. Pure. */
export function reduce(state: ExtensionState, msg: unknown): ExtensionState {
  if (!msg || typeof msg !== 'object') return state;
  const m = msg as Record<string, unknown>;
  if (m.source !== 'aigentron-extension') return state;
  if (m.type === 'ready') {
    return {
      ...state,
      detected: true,
      version: typeof m.version === 'string' ? m.version : null,
      extensionId: typeof m.extensionId === 'string' ? m.extensionId : null,
      connected: m.connected === true,
      needsReconnect: m.needsReconnect === true,
      user: typeof m.user === 'string' ? m.user : null,
    };
  }
  if (m.type === 'paired') return { ...state, busy: false, error: m.ok === true ? null : typeof m.error === 'string' ? m.error : 'The extension did not accept the code' };
  return state;
}

let state = INITIAL;
const listeners = new Set<() => void>();
const set = (next: ExtensionState) => {
  state = next;
  for (const l of listeners) l();
};

let started = false;
function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    set(reduce(state, e.data));
  });
  ping();
  // the content script announces itself at document_idle; a page that mounted earlier simply asks again a moment later
  window.setTimeout(ping, 1500);
}

const post = (msg: Record<string, unknown>) => window.postMessage({ source: 'aigentron-dashboard', ...msg }, window.location.origin);
export const ping = () => post({ type: 'ping' });

/** The address of the API as the extension must use it (a dev stack serves the page and the API on different ports). */
export const apiOrigin = (): string => new URL(API_BASE, window.location.origin).origin;

/** The zip of this server's extension; `origins` adds the page's own address (matters when the page and the API are on different ports). */
export const extensionDownloadUrl = (): string => `${API_BASE}/extension/download?origins=${encodeURIComponent(window.location.origin)}`;

export async function connectExtension(): Promise<void> {
  set({ ...state, busy: true, error: null });
  try {
    const { code } = await api.extensionPair();
    post({ type: 'pair', code, apiOrigin: apiOrigin() });
    // the extension answers with `paired`; if nothing comes back it is not (or no longer) there
    window.setTimeout(() => {
      if (state.busy) set({ ...state, busy: false, error: 'The extension did not answer — is it installed and enabled? Reload this page and try again.' });
    }, 8000);
  } catch (e) {
    set({ ...state, busy: false, error: (e as Error).message });
  }
}

export const disconnectExtension = () => post({ type: 'disconnect' });

export function useExtension(): ExtensionState {
  start();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => INITIAL,
  );
}

/** `0.1.104` vs `0.1.99` → 1 / 0 / -1 (numeric parts). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Is the extension installed in this browser older than the one this server ships? (unknown versions never count) */
export const extensionOutdated = (installed: string | null, shipped: string | undefined): boolean => Boolean(installed && shipped && /^\d/.test(shipped) && compareVersions(shipped, installed) > 0);
