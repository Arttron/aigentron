import { createHash } from 'node:crypto';

/** JSON with object keys sorted at every level — the same value always serialises the same way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Short stable digest of a tool call's arguments. */
export function argsHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input ?? {})).digest('hex').slice(0, 16);
}

/**
 * What an approval exception ("don't ask again") is matched on. Shell commands and file writes already carry their
 * specifics in the summary (`$ <command>`, `Write <path>`), but an MCP call's summary is just the tool name — matching
 * on that alone would let one approval cover EVERY future call of the tool with ANY arguments. So MCP calls are bound
 * to a hash of their arguments: the exception only matches that exact call.
 */
export function exceptionSignature(toolName: string, summary: string, toolInput: unknown): string {
  return toolName.startsWith('mcp__') ? `${summary} #${argsHash(toolInput)}` : summary;
}

/** `APPROVAL_EXCEPTION_TTL_DAYS` — default 30; 0 (or negative) = never expire. */
export function exceptionTtlDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 30;
}

/** The oldest creation time an exception may have and still apply (null = no limit). */
export function exceptionCutoff(ttlDays: number, now = Date.now()): Date | null {
  return ttlDays > 0 ? new Date(now - ttlDays * 86_400_000) : null;
}
