/** Pure helpers for classifying MCP tools from the annotations the server itself reports. */

export interface McpToolInfo {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | null;
}

/**
 * Tools a server declares read-only. A tool counts only when it says `readOnlyHint: true` AND does not
 * also say `destructiveHint: true`. Anything unannotated stays gated (default-deny) — annotations are
 * hints from the server, so this is applied only for servers the operator opted in with `trustAnnotations`.
 */
export function readOnlyFromAnnotations(tools: McpToolInfo[]): string[] {
  return tools
    .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true)
    .map((t) => t.name)
    .sort();
}

/** Config keys that belong to OUR registry, never to the runtime's MCP server config. */
export const REGISTRY_ONLY_KEYS = ['readOnlyTools', 'trustAnnotations', 'discoveredReadOnly'] as const;

export function stripRegistryKeys(config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const k of REGISTRY_ONLY_KEYS) delete out[k];
  return out;
}

/** Effective read-only list for one server: the operator's declaration + discovered ones when trusted. */
export function effectiveReadOnly(config: Record<string, unknown> | null | undefined): string[] | null {
  if (!config) return null;
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const declared = strs(config.readOnlyTools);
  const discovered = config.trustAnnotations === true ? strs(config.discoveredReadOnly) : [];
  const all = [...new Set([...declared, ...discovered])];
  return Array.isArray(config.readOnlyTools) || discovered.length ? all : null;
}
