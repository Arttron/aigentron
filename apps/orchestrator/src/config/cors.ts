/**
 * CORS allowlist resolution, shared by the HTTP bootstrap and the WebSocket
 * gateway (whose decorator is evaluated at import time, before Nest DI, so it
 * can't read AppConfigService).
 *
 * `CORS_ORIGINS` is a comma-separated list of exact origins; `*` opts back into
 * reflecting any origin. With nothing set we allow only localhost/127.0.0.1 on
 * any port — not just the dashboard's own dev server, but any generic
 * browser-based MCP client too (see docs/mcp-entry-point.md) — and reject
 * other sites, so a random page can't make credentialed calls to the
 * orchestrator.
 */
export function resolveCorsOrigin(raw = process.env.CORS_ORIGINS, publicUrl = process.env.PUBLIC_URL): boolean | (string | RegExp)[] {
  const value = raw?.trim();
  if (!value) {
    // PUBLIC_URL (e.g. the Cloudflare Tunnel hostname) is the one extra origin we trust by default.
    const pub = publicOrigin(publicUrl);
    return [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/, ...(pub ? [pub] : [])];
  }
  if (value === '*') return true;
  return value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/** The origin (scheme://host[:port]) of PUBLIC_URL, or null when unset/invalid/not http(s). */
export function publicOrigin(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}
