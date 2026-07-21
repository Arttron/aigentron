/**
 * CORS allowlist resolution, shared by the HTTP bootstrap and the WebSocket
 * gateway (whose decorator is evaluated at import time, before Nest DI, so it
 * can't read AppConfigService).
 *
 * `CORS_ORIGINS` is a comma-separated list of exact origins; `*` opts back into
 * reflecting any origin. With nothing set we allow only localhost/127.0.0.1 on
 * any port (the dashboard) and reject other sites — so a random page can't make
 * credentialed calls to the orchestrator.
 */
export function resolveCorsOrigin(raw = process.env.CORS_ORIGINS): boolean | (string | RegExp)[] {
  const value = raw?.trim();
  if (!value) {
    return [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
  }
  if (value === '*') return true;
  return value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
