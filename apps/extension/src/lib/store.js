// The extension's stored state (chrome.storage.local — never `sync`: the token must not leave this browser).

/** @typedef {{ origin: string, token: string, user: { id: string, displayName: string, role: string }, serverVersion: string, connectedAt: string, needsReconnect?: boolean }} Connection */

/** @returns {Promise<Connection | null>} */
export async function getConnection() {
  const { conn } = await chrome.storage.local.get('conn');
  return conn ?? null;
}

/** @param {Connection | null} conn */
export async function setConnection(conn) {
  if (conn) await chrome.storage.local.set({ conn });
  else await chrome.storage.local.remove('conn');
}

let configPromise = null;

/** What the server wrote into this package: its name, addresses, version, the extension id. A bare template (development) has no config.json. */
export function getConfig() {
  configPromise ??= fetch(chrome.runtime.getURL('config.json'))
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .catch(() => ({ serverName: 'development', origins: ['http://localhost:3011', 'http://localhost:3088'], serverVersion: 'dev', extensionId: chrome.runtime.id }));
  return configPromise;
}
