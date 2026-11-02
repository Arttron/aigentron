import { randomBytes } from 'node:crypto';

/** One-use pairing codes: the signed-in dashboard asks for one, the extension exchanges it for its own token. In memory, short-lived. */
export class PairingCodes {
  private readonly codes = new Map<string, { uid: string; exp: number }>();
  constructor(private readonly ttlMs = 60_000) {}

  issue(uid: string, now = Date.now()): { code: string; expiresInSec: number } {
    for (const [k, v] of this.codes) if (v.exp <= now) this.codes.delete(k);
    if (this.codes.size > 200) this.codes.delete(this.codes.keys().next().value as string);
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, { uid, exp: now + this.ttlMs });
    return { code, expiresInSec: Math.round(this.ttlMs / 1000) };
  }

  /** The user the code was issued to — and the code is gone (one use). null when unknown, used or expired. */
  redeem(code: unknown, now = Date.now()): string | null {
    if (typeof code !== 'string' || code.length > 100) return null;
    const hit = this.codes.get(code);
    if (!hit) return null;
    this.codes.delete(code);
    return hit.exp > now ? hit.uid : null;
  }
}

/**
 * What an extension (device token) may call. It acts as the user that paired it (so that user's role still applies); this is the extra, narrower list on top. Grows with the stages (E1 tasks / KB, E2 approvals …). Everything else — passwords, settings, other sessions,
 * the pairing endpoint itself — is closed to it.
 */
const ALLOWED: ReadonlyArray<{ method: string; re: RegExp }> = [
  { method: 'GET', re: /^\/api\/extension\/me$/ },
  { method: 'POST', re: /^\/api\/extension\/revoke$/ },
  { method: 'GET', re: /^\/api\/health$/ },
  { method: 'GET', re: /^\/api\/auth\/status$/ },
  { method: 'GET', re: /^\/api\/projects$/ },
  { method: 'GET', re: /^\/api\/agents$/ },
  { method: 'GET', re: /^\/api\/knowledge$/ }, // the knowledge bases of a project (the picker of «save to knowledge base»)
  { method: 'GET', re: /^\/api\/approvals$/ }, // the pending requests (the page card, the badge)
  { method: 'POST', re: /^\/api\/approvals\/[\w-]+\/decision$/ }, // approve / deny — the controller refuses the ones that need the dashboard
  { method: 'GET', re: /^\/api\/questions$/ },
  { method: 'GET', re: /^\/api\/questions\/[\w-]+\/image$/ },
  { method: 'POST', re: /^\/api\/questions\/[\w-]+\/answer$/ },
  { method: 'GET', re: /^\/api\/tasks$/ }, // the side panel's task list
  { method: 'GET', re: /^\/api\/tasks\/[\w-]+$/ }, // the title and the project of the task a request belongs to
  { method: 'GET', re: /^\/api\/tasks\/[\w-]+\/transcript$/ }, // the conversation shown in the side panel
  { method: 'POST', re: /^\/api\/tasks\/[\w-]+\/follow-up$/ }, // a message from the side panel
  { method: 'GET', re: /^\/api\/voice$/ }, // is speech recognition set up (the microphone button)
  { method: 'POST', re: /^\/api\/voice\/transcribe$/ }, // dictation: a recording → text
  { method: 'GET', re: /^\/api\/extension\/package$/ }, // the extension updating itself: the zip for this server
  { method: 'POST', re: /^\/api\/extension\/clip$/ }, // send a page / selection / screenshot as a task or a note
];

export function extensionRouteAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const p = path.replace(/\/+$/, '') || '/';
  return ALLOWED.some((a) => a.method === m && a.re.test(p));
}
