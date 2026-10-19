/**
 * Sign-in for providers that use a subscription instead of an API key (docs/provider-login.md): one mechanism, one driver per kind.
 * This file is the pure part — parsing what a login CLI prints and the state a person sees. Nothing here touches processes or secrets.
 */

export type LoginPhase = 'installing' | 'starting' | 'awaiting_browser' | 'awaiting_code' | 'finishing' | 'done' | 'failed' | 'cancelled';

/** What the dashboard gets. Never contains a token or any output of the CLI beyond the link and the short device code. */
export interface LoginView {
  phase: LoginPhase;
  /** The page the person opens to sign in. */
  url: string | null;
  /** A short one-time code to type there (device-code flows). */
  userCode: string | null;
  /** The person has to paste the code the sign-in page shows back here. */
  needsCode: boolean;
  /** One plain sentence about where things stand (or what went wrong). */
  message: string;
  startedAt: string;
  finishedAt: string | null;
}

export const ACTIVE_PHASES: readonly LoginPhase[] = ['installing', 'starting', 'awaiting_browser', 'awaiting_code', 'finishing'];

/** What a driver learns from the CLI's output so far. */
export interface LoginHints {
  url?: string;
  userCode?: string;
  /** A credential the CLI printed (kept server-side, handed to the driver's `finish`). */
  token?: string;
}

/* eslint-disable no-control-regex -- this file parses terminal escape sequences */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_ESC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Terminal escapes and control characters out of a CLI's output (keeps newlines). */
export function stripTerminal(raw: string): string {
  return raw.replace(OSC_ESC, '').replace(CSI, '').replace(/\r/g, '\n').replace(CONTROL, '');
}

/** The first https URL in the output (a terminal hyperlink's target counts), optionally the first one matching `prefer`. */
export function findUrl(raw: string, prefer?: RegExp): string | null {
  // Keep the OSC-8 hyperlink target: drop only CSI first, then read URLs up to whitespace / ESC / BEL.
  const text = raw.replace(CSI, '');
  const urls = Array.from(text.matchAll(/https:\/\/[^\s\x1b\x07"'<>\\]+/g), (m) => m[0].replace(/[.,;)\]]+$/, ''));
  if (!urls.length) return null;
  return (prefer && urls.find((u) => prefer.test(u))) || (prefer ? null : urls[0]!);
}

/** A device code such as `ABCD-EFGH` or `ABCD-12345`. */
export function findDeviceCode(raw: string): string | null {
  const m = stripTerminal(raw).match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/);
  return m ? m[0] : null;
}

/** A long-lived Claude token printed on a line of its own (`sk-ant-oat01-…`). */
export function findClaudeToken(raw: string): string | null {
  for (const line of stripTerminal(raw).split('\n')) {
    const m = line.match(/sk-ant-[A-Za-z0-9_-]{30,}/);
    if (m) return m[0];
  }
  return null;
}

/** The last meaningful lines of the CLI's output, for an error message (never a token). */
export function tailForError(raw: string, lines = 3): string {
  return stripTerminal(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/sk-ant-/.test(l) && /[A-Za-z]{3}/.test(l))
    .slice(-lines)
    .join(' · ')
    .slice(0, 300);
}

/** What to do with what the person pasted into the sign-in box. */
export type LoginInput = { kind: 'stdin'; text: string } | { kind: 'callback'; url: string } | { kind: 'invalid'; why: string };

/**
 * The sign-in page ends in one of three things the person copies back:
 *  - a code to paste into the CLI (`abc…#xyz…`);
 *  - the address of a page that failed to open because it points at `localhost:<port>/callback` (the browser is not on the
 *    server) — the CLI is listening on that port HERE, so the orchestrator makes that request itself (loopback only);
 *  - the address of the hosted "code" page, from which the code is read.
 */
export function classifyLoginInput(raw: string): LoginInput {
  const input = raw.trim();
  if (!input) return { kind: 'invalid', why: 'Paste the code or the address from the sign-in page.' };
  if (/^https?:\/\//i.test(input)) {
    let u: URL;
    try {
      u = new URL(input);
    } catch {
      return { kind: 'invalid', why: 'That is not a valid address.' };
    }
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    if (loopback) {
      if (u.protocol !== 'http:' || !u.port || Number(u.port) < 1024 || !/^\/[\w/-]*callback\/?$/.test(u.pathname) || !u.searchParams.get('code')) {
        return { kind: 'invalid', why: 'Paste the whole address your browser ended on (http://localhost:…/callback?code=…) — it has to include the code.' };
      }
      return { kind: 'callback', url: `http://127.0.0.1:${u.port}${u.pathname}${u.search}` };
    }
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    if (!code) return { kind: 'invalid', why: 'That address has no code in it.' };
    return { kind: 'stdin', text: state ? `${code}#${state}` : code };
  }
  if (/\s/.test(input) || input.length > 2000) return { kind: 'invalid', why: 'That does not look like a code.' };
  return { kind: 'stdin', text: input };
}
