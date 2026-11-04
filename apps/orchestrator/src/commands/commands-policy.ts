/**
 * The MCP servers an agent run gets: its own list, plus `commands` (the command pipeline) automatically when the pipeline is on — nobody has to add it to
 * each agent. Not for chat / question runs and discussion turns (no shell there), and not for an agent whose tool list leaves out Bash or that is forbidden it.
 */
export function mcpWithCommands(names: readonly string[], opts: { enabled: boolean; chat: boolean; discussion: boolean; allowedTools?: readonly string[] | null; disallowedTools?: readonly string[] | null }): string[] {
  const list = [...names];
  const hasBash = !opts.allowedTools?.length || opts.allowedTools.some((t) => t === 'Bash' || t.startsWith('Bash('));
  // a shell taken away from the agent (`disallowedTools: Bash`) must not come back through the pipeline
  const bashOff = Boolean(opts.disallowedTools?.some((t) => t === 'Bash' || t.startsWith('Bash(')));
  if (opts.enabled && !bashOff && !opts.chat && !opts.discussion && hasBash && !list.includes('commands')) list.push('commands');
  return list;
}
