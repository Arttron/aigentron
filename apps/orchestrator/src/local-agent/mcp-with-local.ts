/** The MCP servers a run gets: its own list, plus `local-os` automatically when the run's project has a usable repository on a connected computer. Not for the admin, not for discussion turns. */
export function mcpWithLocal(names: readonly string[], opts: { available: boolean; isAdmin: boolean; discussion: boolean }): string[] {
  const list = [...names];
  if (opts.available && !opts.isAdmin && !opts.discussion && !list.includes('local-os')) list.push('local-os');
  return list;
}
