/**
 * Pure building blocks of the add-ons framework (docs/addons.md): descriptor + state parsing (never trust a file), the
 * endpoint whitelist, the header filters of the view proxy, and the viewing-session limiter. No Nest, no I/O — unit-tested.
 */
import { isIP } from 'node:net';

export type AddonBackend = 'bare' | 'docker';
export const ADDON_BACKENDS: readonly AddonBackend[] = ['bare', 'docker'];

/** `infra/addons/<name>/addon.json` — what an add-on is and needs (shipped with the app). */
export interface AddonDescriptor {
  name: string;
  title: string;
  description: string;
  requires: { ramMb: number; diskMb: number };
  /** the browser add-on has view + cdp, the Playwright one an MCP port; a port an add-on does not have is null */
  ports: { view: number | null; cdp: number | null; mcp: number | null };
  backends: AddonBackend[];
}

/** `<data>/addons/<name>/state.json` — written by the installer after `aigentron addon enable <name>`. */
export interface AddonState {
  name: string;
  enabled: boolean;
  backend: AddonBackend;
  version: string;
  installedAt: string | null;
  browser: string | null;
  arch: string | null;
  endpoints: { view: string | null; cdp: string | null; mcp: string | null };
  profiles: string[];
  notes: string[];
}

export type AddonStatus = 'not-installed' | 'enabled-healthy' | 'enabled-unreachable' | 'disabled';

/** A validated loopback / internal endpoint the proxy may connect to. */
export interface Endpoint {
  hostname: string;
  port: number;
  /** '' or '/some/base' (never a trailing slash) — prefixed to every proxied path. */
  basePath: string;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Only the browser add-on exists in stage 1; the shipped descriptor file overrides this when present. */
export const BUILTIN_DESCRIPTORS: readonly AddonDescriptor[] = [
  {
    name: 'browser',
    title: 'Browser',
    description:
      'A real Chromium browser running on the server. You watch and operate it from the dashboard; agents drive the same browser. Sign in to sites once, and the agents can use them.',
    requires: { ramMb: 1536, diskMb: 1500 },
    ports: { view: 6080, cdp: 9222, mcp: null },
    backends: ['bare', 'docker'],
  },
  {
    name: 'playwright',
    title: 'Playwright browser for agents',
    description:
      'A headless Chromium behind the Playwright MCP server, for the agents\' browser work (screenshots, checking a page, filling a form). Separate from the Browser add-on, so a personal browser stays personal.',
    requires: { ramMb: 1536, diskMb: 1500 },
    ports: { view: null, cdp: null, mcp: 8931 },
    backends: ['bare'],
  },
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const int = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null);
const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, maxLen)).slice(0, maxItems) : [];

export function parseDescriptor(raw: unknown): Parsed<AddonDescriptor> {
  if (!isObj(raw)) return { ok: false, error: 'not an object' };
  const name = str(raw.name, 40);
  if (!name || !NAME_RE.test(name)) return { ok: false, error: 'name must be lowercase letters, digits and dashes' };
  const title = str(raw.title, 80)?.trim();
  if (!title) return { ok: false, error: 'title is required' };
  const description = str(raw.description, 600)?.trim() ?? '';
  const req = isObj(raw.requires) ? raw.requires : {};
  const ports = isObj(raw.ports) ? raw.ports : {};
  // each port is optional (the browser add-on has view + cdp, the Playwright one has mcp), but a given one must be valid and one must exist
  const optPort = (v: unknown): number | null | 'bad' => (v === undefined || v === null ? null : (int(v, 1, 65535) ?? 'bad'));
  const view = optPort(ports.view);
  const cdp = optPort(ports.cdp);
  const mcp = optPort(ports.mcp);
  if (view === 'bad' || cdp === 'bad' || mcp === 'bad') return { ok: false, error: 'ports.view, ports.cdp and ports.mcp must be 1–65535' };
  if (view === null && cdp === null && mcp === null) return { ok: false, error: 'the add-on needs at least one port (view, cdp or mcp)' };
  const backends = Array.isArray(raw.backends) ? raw.backends.filter((b): b is AddonBackend => (ADDON_BACKENDS as readonly unknown[]).includes(b)) : [];
  if (backends.length === 0) return { ok: false, error: 'backends must list bare and/or docker' };
  return {
    ok: true,
    value: {
      name,
      title,
      description,
      requires: { ramMb: int(req.ramMb, 0, 1_000_000) ?? 0, diskMb: int(req.diskMb, 0, 10_000_000) ?? 0 },
      ports: { view, cdp, mcp },
      backends: [...new Set(backends)],
    },
  };
}

/**
 * Is this a host the proxy may talk to? Loopback, the docker host alias, a single-label name (a docker service on the
 * internal network — no dots, so it cannot be a public name), or a private (RFC 1918) address. Anything public is refused:
 * the file is written by root, but the proxy must never become a way to reach the internet with the person's session.
 */
export function endpointHostAllowed(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === 'host.docker.internal') return true;
  const family = isIP(h);
  if (family === 6) return h === '::1' || /^::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (family === 4) return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  return /^[a-z0-9][a-z0-9_-]{0,62}$/.test(h);
}

/** `http://127.0.0.1:6080` (optionally with a base path) → a validated endpoint; everything else is refused. */
export function parseEndpoint(raw: unknown): Parsed<Endpoint> {
  if (typeof raw !== 'string' || raw.length > 300) return { ok: false, error: 'not a string' };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'not a URL' };
  }
  if (u.protocol !== 'http:') return { ok: false, error: 'only http:// endpoints' };
  if (u.username || u.password || u.search || u.hash) return { ok: false, error: 'no credentials, query or fragment' };
  const hostname = u.hostname.replace(/^\[|\]$/g, '');
  if (!endpointHostAllowed(hostname)) return { ok: false, error: `host ${hostname} is not loopback / internal` };
  const port = u.port ? Number(u.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'port must be 1–65535' };
  const basePath = u.pathname.replace(/\/+$/, '');
  if (basePath.split('/').some((s) => s === '..' || s === '.')) return { ok: false, error: 'bad base path' };
  return { ok: true, value: { hostname, port, basePath } };
}

/** The state file; the name inside must match the folder it was found in. Endpoints are validated, not trusted. */
export function parseState(raw: unknown, name: string): Parsed<AddonState> {
  if (!isObj(raw)) return { ok: false, error: 'not an object' };
  if (raw.name !== name) return { ok: false, error: `name is not "${name}"`};
  if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'enabled must be true/false' };
  const backend = (ADDON_BACKENDS as readonly unknown[]).includes(raw.backend) ? (raw.backend as AddonBackend) : null;
  if (!backend) return { ok: false, error: 'backend must be bare or docker' };
  const ep = isObj(raw.endpoints) ? raw.endpoints : {};
  const view = ep.view === undefined || ep.view === null ? null : parseEndpoint(ep.view);
  if (view && !view.ok) return { ok: false, error: `endpoints.view: ${view.error}` };
  const cdp = ep.cdp === undefined || ep.cdp === null ? null : parseEndpoint(ep.cdp);
  if (cdp && !cdp.ok) return { ok: false, error: `endpoints.cdp: ${cdp.error}` };
  const mcp = ep.mcp === undefined || ep.mcp === null ? null : parseEndpoint(ep.mcp);
  if (mcp && !mcp.ok) return { ok: false, error: `endpoints.mcp: ${mcp.error}` };
  return {
    ok: true,
    value: {
      name,
      enabled: raw.enabled,
      backend,
      version: str(raw.version, 60) ?? '',
      installedAt: str(raw.installedAt, 60),
      browser: str(raw.browser, 120),
      arch: str(raw.arch, 40),
      endpoints: { view: view ? (ep.view as string) : null, cdp: cdp ? (ep.cdp as string) : null, mcp: mcp ? (ep.mcp as string) : null },
      profiles: strList(raw.profiles, 20, 60),
      notes: strList(raw.notes, 20, 400),
    },
  };
}

/** The SSE address of the Playwright add-on's MCP server when it is enabled and its state is valid (what the `playwright` MCP server should point at), else null. */
export function playwrightSseUrl(raw: unknown): string | null {
  const r = parseState(raw, 'playwright');
  if (!r.ok || !r.value.enabled || !r.value.endpoints.mcp) return null;
  const ep = parseEndpoint(r.value.endpoints.mcp);
  if (!ep.ok) return null;
  const host = ep.value.hostname.includes(':') ? `[${ep.value.hostname}]` : ep.value.hostname;
  return `http://${host}:${ep.value.port}${ep.value.basePath}/sse`;
}

export function addonStatus(state: AddonState | null, healthy: boolean | null): AddonStatus {
  if (!state) return 'not-installed';
  if (!state.enabled) return 'disabled';
  return healthy ? 'enabled-healthy' : 'enabled-unreachable';
}

/** The commands the dashboard shows (the person runs them on the server; the dashboard never runs anything). */
export function addonCommands(name: string): { enable: string; enableDocker: string; disable: string; logs: string } {
  return {
    enable: `sudo aigentron addon enable ${name}`,
    enableDocker: `sudo aigentron addon enable ${name} --backend docker`,
    disable: `sudo aigentron addon disable ${name}`,
    logs: `aigentron addon logs ${name}`,
  };
}

// ---- the view proxy ----

export const VIEW_PREFIX = '/api/addons/browser/view';

/** Is this request URL under the view proxy? */
export function isViewPath(url: string | undefined): boolean {
  if (!url) return false;
  return url === VIEW_PREFIX || url.startsWith(`${VIEW_PREFIX}/`) || url.startsWith(`${VIEW_PREFIX}?`);
}

/** `/api/addons/browser/view/app/ui.js?x=1` → `/app/ui.js?x=1`; null when the path tries to climb out. */
export function upstreamPath(url: string): string | null {
  if (!isViewPath(url)) return null;
  let rest = url.slice(VIEW_PREFIX.length);
  if (!rest.startsWith('/')) rest = `/${rest}`;
  const pathOnly = rest.split('?')[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return null;
  }
  if (decoded.includes('\\') || decoded.split('/').some((s) => s === '..')) return null;
  return rest;
}

type Headers = Record<string, string | string[] | undefined>;

/** Allow-list: what a static web server needs. Cookies, the session token, forwarding and Cloudflare headers never leave. */
const HTTP_FORWARD = new Set(['accept', 'accept-encoding', 'accept-language', 'user-agent', 'if-none-match', 'if-modified-since', 'range', 'cache-control', 'pragma']);
const WS_FORWARD = new Set([...HTTP_FORWARD, 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']);

export function forwardRequestHeaders(headers: Headers, upstreamHost: string, ws = false): Record<string, string> {
  const allow = ws ? WS_FORWARD : HTTP_FORWARD;
  const out: Record<string, string> = { host: upstreamHost };
  for (const [k, v] of Object.entries(headers)) {
    if (!allow.has(k) || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

const RESPONSE_FORWARD = new Set(['content-type', 'content-length', 'content-encoding', 'etag', 'last-modified', 'cache-control', 'accept-ranges', 'content-range', 'vary', 'date', 'location']);

/** The upstream's answer, minus anything that is not a plain static-file header, plus the restrictive headers of the proxy. */
export function responseHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(upstream)) {
    if (!RESPONSE_FORWARD.has(k) || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  // noVNC's page must only ever be framed by the dashboard itself; its assets may be cached per browser, never shared
  out['x-frame-options'] = 'SAMEORIGIN';
  out['content-security-policy'] = "frame-ancestors 'self'";
  out['x-content-type-options'] = 'nosniff';
  out['referrer-policy'] = 'no-referrer';
  out['cache-control'] = out['cache-control'] ? `private, ${out['cache-control'].replace(/\bpublic\b,?\s*/g, '')}` : 'private, max-age=600';
  return out;
}

/** The headers of the 101 answer we relay to the browser (from the upstream's handshake). */
export function upgradeResponseHeaders(upstream: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = upstream[k];
    if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/** A server→client WebSocket close frame (unmasked), so the browser learns WHY the stream ended. */
export function wsCloseFrame(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123);
  const frame = Buffer.alloc(4 + text.length);
  frame[0] = 0x88; // FIN + close
  frame[1] = 2 + text.length;
  frame.writeUInt16BE(code, 2);
  text.copy(frame, 4);
  return frame;
}

/** Raw-HTTP refusal for an upgrade request (a WebSocket client sees the status; curl sees the text). */
export function rawHttpAnswer(status: number, text: string): string {
  const reason = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 503 ? 'Service Unavailable' : status === 502 ? 'Bad Gateway' : 'Error';
  const body = Buffer.byteLength(text);
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body}\r\nConnection: close\r\n\r\n${text}`;
}

export interface ViewSession {
  id: number;
  userId: string;
  userName: string;
  role: string;
  from: string;
  openedAt: number;
}

/** Who is watching right now: at most `max` streams at once, each ending after `limitMs`. */
export class ViewSessions {
  private next = 1;
  private readonly open_ = new Map<number, ViewSession>();

  constructor(
    readonly max: number,
    readonly limitMs: number,
  ) {}

  get count(): number {
    return this.open_.size;
  }

  list(): ViewSession[] {
    return [...this.open_.values()];
  }

  /** A new stream, or null when the cap is reached. */
  open(who: Omit<ViewSession, 'id' | 'openedAt'>, now = Date.now()): ViewSession | null {
    if (this.open_.size >= this.max) return null;
    const s: ViewSession = { ...who, id: this.next++, openedAt: now };
    this.open_.set(s.id, s);
    return s;
  }

  close(id: number): ViewSession | null {
    const s = this.open_.get(id) ?? null;
    this.open_.delete(id);
    return s;
  }

  /** Milliseconds this session has left (0 when it is over). */
  remaining(s: ViewSession, now = Date.now()): number {
    return Math.max(0, s.openedAt + this.limitMs - now);
  }
}

/** "1h 02m" / "12m 05s" for the audit line. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
