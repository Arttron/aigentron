import { findClaudeToken, findDeviceCode, findUrl } from './login-core';
import type { LoginDriver } from './login-session';

/** Codex (ChatGPT subscription): `codex login --device-auth` prints a link and a one-time code, and exits 0 once the person has entered it. */
export function codexDriver(done: () => Promise<string>): LoginDriver {
  return {
    needsCode: false,
    finishOnToken: false,
    interpret: (o) => ({ url: findUrl(o, /openai\.com|chatgpt\.com/) ?? findUrl(o) ?? undefined, userCode: findDeviceCode(o) ?? undefined }),
    finish: done,
  };
}

/**
 * Claude (Pro/Max subscription): `claude setup-token` prints an authorize link; the page shows a code the person pastes back, and the
 * CLI prints a one-year token, which is stored as the provider's secret (never shown, never logged).
 */
export function claudeDriver(store: (token: string) => Promise<string>): LoginDriver {
  return {
    needsCode: true,
    finishOnToken: true,
    interpret: (o) => ({ url: findUrl(o, /oauth\/authorize/) ?? undefined, token: findClaudeToken(o) ?? undefined }),
    finish: async ({ token }) => {
      if (!token) throw new Error('the CLI finished without printing a token');
      return store(token);
    },
  };
}
