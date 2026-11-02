// A minimal Socket.IO (Engine.IO v4) client over a plain WebSocket: just what the extension needs to hear the server's events and to say "focus / blur".
// Written by hand because the extension has no build step (and a library would be ~50 KB for a handful of packet types). The service worker stays
// alive while messages flow (Chrome ≥ 116), and the server pings every ~25 s, so one connection is enough.

/** One WebSocket text frame → a packet. Unknown frames → null. */
export function parsePacket(text) {
  if (typeof text !== 'string' || !text) return null;
  const t = text[0];
  if (t === '0') return { type: 'open', data: safe(text.slice(1)) };
  if (t === '1') return { type: 'close' };
  if (t === '2') return { type: 'ping' };
  if (t !== '4') return null;
  const s = text[1];
  if (s === '0') return { type: 'connect', data: safe(text.slice(2)) };
  if (s === '1') return { type: 'disconnect' };
  if (s === '4') return { type: 'error', data: safe(text.slice(2)) };
  if (s === '2') {
    // an event: `42["name",arg…]` (an ack id between 2 and the array is not used by this server for these events)
    const arr = safe(text.slice(text.indexOf('[')));
    return Array.isArray(arr) && typeof arr[0] === 'string' ? { type: 'event', name: arr[0], args: arr.slice(1) } : null;
  }
  return null;
}

function safe(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export const encodeConnect = (auth) => `40${JSON.stringify(auth ?? {})}`;
export const encodeEvent = (name, ...args) => `42${JSON.stringify([name, ...args])}`;
export const PONG = '3';

/** `http://host:3011` → `ws://host:3011/socket.io/?EIO=4&transport=websocket` */
export const socketUrl = (origin) => `${origin.replace(/^http/, 'ws')}/socket.io/?EIO=4&transport=websocket`;

/** Backoff for reconnecting: 1, 2, 5, 10, 30 seconds, then every 30. */
export const backoffMs = (attempt) => [1000, 2000, 5000, 10000, 30000][Math.min(attempt, 4)];

/**
 * A reconnecting connection. `onEvent(name, args)`, `onState('connecting' | 'open' | 'closed')`. `open` means the server accepted the connect packet.
 * Authenticates with `auth` in the connect packet (an extension cannot set headers on a WebSocket).
 */
export class SioClient {
  constructor({ url, auth, onEvent, onState, WebSocketImpl = WebSocket }) {
    Object.assign(this, { url, auth, onEvent, onState, WS: WebSocketImpl, ws: null, attempt: 0, timer: null, stopped: false, connected: false });
  }

  start() {
    this.stopped = false;
    this.open();
  }

  open() {
    if (this.stopped || this.ws) return;
    this.onState?.('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      const p = parsePacket(typeof e.data === 'string' ? e.data : '');
      if (!p) return;
      if (p.type === 'open') ws.send(encodeConnect(this.auth));
      else if (p.type === 'ping') ws.send(PONG);
      else if (p.type === 'connect') {
        this.connected = true;
        this.attempt = 0;
        this.onState?.('open');
      } else if (p.type === 'event') this.onEvent?.(p.name, p.args);
      else if (p.type === 'disconnect' || p.type === 'error') ws.close();
    };
    ws.onclose = () => {
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      this.onState?.('closed', was);
      this.retry();
    };
    ws.onerror = () => undefined; // the close that follows is what counts
  }

  retry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, backoffMs(this.attempt++));
  }

  emit(name, ...args) {
    if (this.connected && this.ws?.readyState === 1) this.ws.send(encodeEvent(name, ...args));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
