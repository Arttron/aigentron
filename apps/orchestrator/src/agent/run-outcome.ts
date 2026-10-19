import type { ReportedStatus } from '@lds/agent-runner';

/**
 * Pure helpers around a run's outcome (no Nest/Prisma): failover worthiness,
 * the human-facing report text, session-id tagging per runtime. Extracted from
 * the executor so the riskiest decisions are unit-tested (E-29).
 */

/**
 * Human-facing text of a report: summary + the blocked `handoff` (what the agent
 * needs from a human). Folding handoff in here is what carries a blocked agent's
 * question into task.error → fan-in summaries → escalations; without it the
 * question would be silently dropped.
 */
export function reportText(report: ReportedStatus): string | null {
  const summary = report.summary?.trim();
  const handoff = report.handoff?.trim();
  if (summary && handoff) return `${summary}\n\nNeeds from a human: ${handoff}`;
  return summary || handoff || null;
}

/**
 * Provider-level failure patterns worth failing over to the next provider:
 * transport/connection, HTTP 4xx/5xx from the endpoint, rate limits, auth, and
 * model/tool-capability errors (e.g. a local model that can't emit tool calls).
 * Deliberately excludes aborts/timeouts (handled separately) and clean runs.
 */
// Keyed off reason phrases and status-codes-in-context — NOT bare digits, which
// match a stray "500"/"403" in a file path / diff / echoed model output and
// trigger a spurious failover. The catch-path already fails over on any non-abort
// throw, so this only needs to catch provider errors that arrive as a *result*.
export const FAILOVER_PATTERNS: readonly RegExp[] = [
  // the limit / plan / balance is used up (a fallback is exactly for this)
  /insufficient[\s_-]?(quota|funds|balance|credits?)|(exceeded|exhausted|reached)\b[^.\n]{0,30}\b(quota|usage limit|plan limit|spending limit|monthly limit)|quota[^.\n]{0,20}(exceeded|exhausted|reached)|credit balance[^.\n]{0,20}(too low|exhausted)|payment required|usage limit|limit reached|(5|five)[- ]hour limit|weekly limit/i,
  /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE/i,
  /socket hang up|fetch failed|network error|connection (error|closed|refused)/i,
  /rate.?limit|too many requests|overloaded|capacity|temporarily unavailable/i,
  /internal server error|bad gateway|service unavailable|gateway timeout/i,
  /unauthorized|forbidden|authentication|invalid.*(api.?key|token)/i,
  /not signed in|failed to start \w+: spawn \S+ ENOENT/i,
  // A status code only when qualified by a status keyword (HTTP/status/code/error).
  /\b(?:http|status(?:\s*code)?|code|error)\b[^0-9a-z]{0,8}(?:401|403|404|408|409|429|5\d\d)\b/i,
  /model.*(not found|not exist|unavailable|does not support)|no endpoints|unsupported model|invalid model/i,
  /does not support tools|tool use is not supported|function calling is not/i,
];

/**
 * "The limit / the plan is used up" — a different thing from a transient rate limit: retrying the same provider will not help for a
 * long while (a subscription's window, a prepaid balance, a monthly cap), so the next run should start on a fallback right away.
 */
export const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient[\s_-]?(quota|funds|balance|credits?)/i,
  /(exceeded|exhausted|used up|reached)\b[^.\n]{0,30}\b(quota|usage limit|plan limit|spending limit|monthly limit|credit)/i,
  /quota[^.\n]{0,20}(exceeded|exhausted|reached)/i,
  /(out of|no (more )?|run out of) credits?|credit balance[^.\n]{0,20}(too low|exhausted|empty|is zero)/i,
  /payment required|billing[^.\n]{0,30}(issue|problem|inactive|not (active|set up)|limit)|add (a )?payment|upgrade your plan/i,
  /usage limit|limit reached|(5|five)[- ]hour limit|weekly limit|you.?ve hit your|resets? (at|in|on)|try again (in|at|after) \d/i,
];

export type ProviderFailureKind = 'quota' | 'rate' | 'auth' | 'other';

/** What kind of provider failure this message describes (for the cool-down and the hint shown to people). */
export function classifyProviderFailure(message: string | undefined | null): ProviderFailureKind {
  const m = message ?? '';
  if (!m) return 'other';
  if (QUOTA_PATTERNS.some((re) => re.test(m))) return 'quota';
  if (/rate.?limit|too many requests|overloaded|capacity|temporarily unavailable|\b429\b/i.test(m)) return 'rate';
  if (/unauthorized|forbidden|authentication|invalid.*(api.?key|token)|not signed in|\b40[13]\b/i.test(m)) return 'auth';
  return 'other';
}

export function isFailoverWorthy(message: string): boolean {
  if (!message) return false;
  // Abort/timeout are orchestrator-driven stops, not provider failures.
  if (/\baborted\b|timed out/i.test(message)) return false;
  return FAILOVER_PATTERNS.some((re) => re.test(message)) || QUOTA_PATTERNS.some((re) => re.test(message));
}

export function shortReason(message: string): string {
  const m = (message || 'provider error').replace(/\s+/g, ' ').trim();
  return m.length > 80 ? `${m.slice(0, 80)}…` : m;
}

/** The provider's error, trimmed for `task.error` (X-FO-6): one paragraph, bounded. */
export function errorTextOf(message: string | undefined | null): string | undefined {
  const m = (message ?? '').replace(/\s+/g, ' ').trim();
  if (!m) return undefined;
  return m.length > 500 ? `${m.slice(0, 500)}…` : m;
}

/** Session ids are runtime-specific: Codex thread ids are stored with a `codex:` prefix. */
export function tagSessionId(id: string | null, codex: boolean): string | null {
  return id && codex ? `codex:${id}` : id;
}

/** The raw id this runtime can resume, or undefined if the stored session belongs to the other runtime. */
export function untagSessionId(stored: string | undefined, codex: boolean): string | undefined {
  if (!stored) return undefined;
  const isCodexId = stored.startsWith('codex:');
  if (codex) return isCodexId ? stored.slice('codex:'.length) : undefined;
  return isCodexId ? undefined : stored;
}
