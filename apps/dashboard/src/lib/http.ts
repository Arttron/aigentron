import { API_BASE } from './config';

/** A non-2xx answer from the API. `message` keeps the legacy "<status> <text> — <body>" form; `detail` is the clean server text. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    statusText = '',
  ) {
    super(`${status} ${statusText}${detail ? ` — ${detail}` : ''}`);
    this.name = 'ApiError';
  }
}

/** The text a person should read for any thrown value (ApiError → the server's message, else Error.message). */
export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.detail || e.message;
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^\d+ [^—]*— /, '');
}

/** An HTML page where data was expected: a proxy / CDN error page (Cloudflare 520, nginx 502 …), never something to show as text. */
const looksLikeHtml = (body: string): boolean => /^\s*(<!doctype html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(body);

/** What a person should read for the body of a failed answer: the server's text, or a plain sentence instead of a pasted error page. */
export function cleanErrorBody(status: number, body: string): string {
  if (looksLikeHtml(body)) {
    // 502/503/504 and Cloudflare's 520-527: the server behind the proxy is not answering (restarting, overloaded, busy)
    if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 527)) {
      return `The server is not reachable right now (HTTP ${status}) — it may be restarting or busy. Try again in a minute.`;
    }
    return `The server answered with a web page instead of data (HTTP ${status}).`;
  }
  const t = body.trim();
  // a JSON body (a Nest error) is kept whole up to a generous cap: the caller parses its `message`; cut text would not parse
  const cap = t.startsWith('{') || t.startsWith('[') ? 20_000 : 600;
  return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

/** Parses a JSON answer or throws ApiError (status + the server's body text). */
export async function unwrap<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(res.status, cleanErrorBody(res.status, body), res.statusText);
  }
  return res.json() as Promise<T>;
}

/** `?a=1&b=2` for the values that are not undefined/null (numbers and booleans are stringified); '' when there are none. */
export function buildQuery(params?: Record<string, string | number | boolean | null | undefined>): string {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body (sets content-type: application/json). */
  body?: unknown;
  /** Raw body (a File/Blob/string) sent as is; pair with `headers` for its content-type. */
  raw?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Hook for the acting-user header; api.ts registers it so this module stays free of storage details. */
let actingHeaders: () => Record<string, string> = () => ({});
export function setActingHeaders(fn: () => Record<string, string>): void {
  actingHeaders = fn;
}

/** The ONE fetch wrapper: base URL, no-store on GET, acting-user header, JSON/raw body, AbortSignal, ApiError on non-2xx. */
export function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...actingHeaders(), ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const init: RequestInit = { method, headers, body, signal: opts.signal };
  if (method === 'GET') init.cache = 'no-store';
  return fetch(`${API_BASE}${path}${buildQuery(opts.query)}`, init).then((r) => unwrap<T>(r));
}
