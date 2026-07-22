/**
 * Public endpoints the browser uses to reach the orchestrator.
 *
 * Defaults to same-origin (relative paths) so a production build served by
 * the orchestrator itself needs no configuration. `VITE_ORCHESTRATOR_URL` is
 * a dev-only escape hatch for running this SPA on its own Vite port against
 * a separately-running orchestrator.
 */
export const ORCHESTRATOR_URL = import.meta.env.VITE_ORCHESTRATOR_URL ?? '';

export const API_BASE = `${ORCHESTRATOR_URL}/api`;

/**
 * Socket.IO endpoint. Socket.IO speaks over http(s), so coerce a ws(s):// value
 * to its http(s) equivalent; `undefined` (rather than an empty string) tells
 * socket.io-client to default to same-origin.
 */
const rawSocketUrl = import.meta.env.VITE_ORCHESTRATOR_WS_URL ?? ORCHESTRATOR_URL;
export const SOCKET_URL = rawSocketUrl ? rawSocketUrl.replace(/^ws(s?):\/\//, 'http$1://') : undefined;
