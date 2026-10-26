import { NAME_RE, isBuiltinAgent } from './agent-registry.service';

/** A portable agent: its file plus the custom / learned skills it carries ("the agent with its experience"). */
export interface AgentBundle {
  format: 'aigentron-agent';
  version: 1;
  exportedAt: string;
  agent: { name: string; content: string };
  skills: BundleSkill[];
}
export interface BundleSkill {
  name: string;
  kind: 'custom' | 'learned';
  content: string;
}

export const MAX_ITEM_BYTES = 16_000;
export const MAX_SKILLS = 30;
export const MAX_BUNDLE_BYTES = 256_000;

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Checks the shape and the limits of an uploaded bundle; returns the cleaned bundle or the list of problems. */
export function validateBundle(raw: unknown): { bundle?: AgentBundle; errors: string[] } {
  const errors: string[] = [];
  const b = raw as Partial<AgentBundle> | null;
  if (!b || typeof b !== 'object' || b.format !== 'aigentron-agent') return { errors: ['Not an Aigentron agent bundle (format must be "aigentron-agent").'] };
  if (b.version !== 1) return { errors: [`Unsupported bundle version ${String(b.version)}.`] };
  const agent = b.agent;
  if (!agent || typeof agent.name !== 'string' || typeof agent.content !== 'string') return { errors: ['The bundle has no agent.'] };
  if (!NAME_RE.test(agent.name)) errors.push(`Invalid agent name "${agent.name}".`);
  if (bytes(agent.content) > MAX_ITEM_BYTES) errors.push(`The agent file is over ${MAX_ITEM_BYTES} bytes.`);
  const skills = Array.isArray(b.skills) ? b.skills : [];
  if (skills.length > MAX_SKILLS) errors.push(`More than ${MAX_SKILLS} skills.`);
  let total = bytes(agent.content);
  const seen = new Set<string>();
  const clean: BundleSkill[] = [];
  for (const s of skills.slice(0, MAX_SKILLS)) {
    if (!s || typeof s.name !== 'string' || typeof s.content !== 'string' || (s.kind !== 'custom' && s.kind !== 'learned')) {
      errors.push('A skill entry is malformed.');
      continue;
    }
    if (!NAME_RE.test(s.name)) errors.push(`Invalid skill name "${s.name}".`);
    if (bytes(s.content) > MAX_ITEM_BYTES) errors.push(`Skill "${s.name}" is over ${MAX_ITEM_BYTES} bytes.`);
    const key = `${s.kind}:${s.name}`;
    if (seen.has(key)) errors.push(`Skill "${key}" is listed twice.`);
    seen.add(key);
    total += bytes(s.content);
    clean.push({ name: s.name, kind: s.kind, content: s.content });
  }
  if (total > MAX_BUNDLE_BYTES) errors.push(`The bundle is over ${MAX_BUNDLE_BYTES} bytes.`);
  if (errors.length) return { errors };
  return { bundle: { format: 'aigentron-agent', version: 1, exportedAt: String(b.exportedAt ?? ''), agent: { name: agent.name, content: agent.content }, skills: clean }, errors };
}

export type ItemStatus = 'new' | 'same' | 'different' | 'blocked';
export interface PlanItem {
  /** `agent:<name>` or `skill:<kind>:<name>` — what `overwrite` refers to. */
  key: string;
  kind: 'agent' | 'custom' | 'learned';
  name: string;
  status: ItemStatus;
  /** Why it is blocked, or what to know. */
  note?: string;
  /** Will it be written by this import. */
  write: boolean;
}

/** What an import would do, given what is on disk (`existing`: key → current content; `core`: names of shipped skills). */
export function planImport(
  bundle: AgentBundle,
  existing: Map<string, string>,
  core: Set<string>,
  opts: { agentName?: string; overwrite?: string[] },
): PlanItem[] {
  const over = new Set(opts.overwrite ?? []);
  const items: PlanItem[] = [];
  const agentName = opts.agentName || bundle.agent.name;
  const push = (key: string, kind: PlanItem['kind'], name: string, content: string, blockedNote?: string) => {
    const cur = existing.get(key);
    const status: ItemStatus = blockedNote ? 'blocked' : cur === undefined ? 'new' : cur === content ? 'same' : 'different';
    items.push({ key, kind, name, status, note: blockedNote, write: status === 'new' || (status === 'different' && over.has(key)) });
  };
  if (!NAME_RE.test(agentName)) push(`agent:${agentName}`, 'agent', agentName, bundle.agent.content, 'Invalid name.');
  else if (isBuiltinAgent(agentName)) push(`agent:${agentName}`, 'agent', agentName, bundle.agent.content, 'A built-in agent cannot be replaced — import under another name.');
  else push(`agent:${agentName}`, 'agent', agentName, bundle.agent.content);
  for (const s of bundle.skills) {
    const key = `skill:${s.kind}:${s.name}`;
    push(key, s.kind, s.name, s.content, core.has(s.name) ? 'A shipped skill has this name.' : undefined);
  }
  return items;
}
