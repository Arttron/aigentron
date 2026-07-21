/** Public endpoints the browser uses to reach the orchestrator. */
export const ORCHESTRATOR_URL =
  process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? 'http://localhost:3001';

export const API_BASE = `${ORCHESTRATOR_URL}/api`;

/**
 * Socket.IO endpoint. Socket.IO speaks over http(s), so coerce a ws(s):// value
 * to its http(s) equivalent; fall back to the REST origin.
 */
export const SOCKET_URL = (
  process.env.NEXT_PUBLIC_ORCHESTRATOR_WS_URL ?? ORCHESTRATOR_URL
).replace(/^ws(s?):\/\//, 'http$1://');
