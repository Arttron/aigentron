import { getConnection, setConnection } from './store.js';

export class ApiError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function message(res) {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return String(j.message ?? j.error ?? text).slice(0, 300);
  } catch {
    return text.slice(0, 300) || `HTTP ${res.status}`;
  }
}

/**
 * A call to the paired server with the extension's token. A 401 means the token was revoked or expired: the connection is marked "needs reconnect"
 * (the popup offers it) — the token is kept so nothing is lost silently, but never used again until the person reconnects on the dashboard.
 */
export async function apiFetch(path, init = {}) {
  const conn = await getConnection();
  if (!conn) throw new ApiError(0, 'Not connected');
  const res = await fetch(`${conn.origin}${path}`, {
    ...init,
    headers: { ...(init.body && !(init.body instanceof FormData) && !(init.body instanceof Blob) ? { 'content-type': 'application/json' } : {}), ...init.headers, authorization: `Bearer ${conn.token}`, 'x-extension-version': chrome.runtime.getManifest().version },
  }).catch((e) => {
    throw new ApiError(0, `Could not reach the server: ${e.message}`);
  });
  if (res.status === 401) {
    if (!conn.needsReconnect) await setConnection({ ...conn, needsReconnect: true });
    throw new ApiError(401, 'The extension was signed out — reconnect from the dashboard');
  }
  if (!res.ok) throw new ApiError(res.status, await message(res));
  return res.status === 204 ? null : res.json();
}

/** The one call that works without a token: exchange the pairing code (the page gave it to the extension). */
export async function exchangeCode(origin, code, device) {
  const res = await fetch(`${origin}/api/extension/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, device }) }).catch((e) => {
    throw new ApiError(0, `Could not reach the server: ${e.message}`);
  });
  if (!res.ok) throw new ApiError(res.status, await message(res));
  return res.json();
}

/** A file from the paired server (a zip): the bytes. */
export async function apiBlob(path) {
  const conn = await getConnection();
  if (!conn) throw new ApiError(0, 'Not connected');
  const res = await fetch(`${conn.origin}${path}`, { headers: { authorization: `Bearer ${conn.token}`, 'x-extension-version': chrome.runtime.getManifest().version } }).catch((e) => {
    throw new ApiError(0, `Could not reach the server: ${e.message}`);
  });
  if (!res.ok) throw new ApiError(res.status, await message(res));
  return new Uint8Array(await res.arrayBuffer());
}
