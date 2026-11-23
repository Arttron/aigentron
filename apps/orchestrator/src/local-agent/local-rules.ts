/**
 * The global rules of the local agents (Add-ons → Local agent): what an agent may do on its own in a repository. The Go daemon reads the same document
 * (apps/local-agent/internal/rules) and the two are tied by the fixtures in packages/shared/protocol/local-agent/rules. The project's own file
 * (`.aigentron/local.yaml`) is read by the daemon only — it may switch rules off and tune them, and switches one on only if `projectCanEnable` lists it.
 */
export const RULE_NAMES = ['snapshot', 'fetch', 'fastForward', 'notify', 'proposeCommit'] as const;
export type RuleName = (typeof RULE_NAMES)[number];

export interface LocalRules {
  snapshot: { enabled: boolean; idleMinutes: number; keep: number };
  fetch: { enabled: boolean; everyMinutes: number };
  fastForward: { enabled: boolean };
  notify: { enabled: boolean; dirtyAfterMinutes: number; behindAfterMinutes: number };
  proposeCommit: { enabled: boolean; idleMinutes: number };
  quiet: { typingSeconds: number };
  ignore: string[];
  projectCanEnable: RuleName[];
}

export const DEFAULT_RULES: LocalRules = {
  snapshot: { enabled: true, idleMinutes: 2, keep: 20 },
  fetch: { enabled: true, everyMinutes: 5 },
  fastForward: { enabled: false },
  notify: { enabled: true, dirtyAfterMinutes: 60, behindAfterMinutes: 30 },
  proposeCommit: { enabled: false, idleMinutes: 30 },
  quiet: { typingSeconds: 20 },
  ignore: [],
  projectCanEnable: [],
};

const BOUNDS: Record<string, [number, number]> = {
  'snapshot.idleMinutes': [1, 120],
  'snapshot.keep': [1, 200],
  'fetch.everyMinutes': [1, 1440],
  'notify.dirtyAfterMinutes': [1, 10080],
  'notify.behindAfterMinutes': [1, 10080],
  'proposeCommit.idleMinutes': [5, 1440],
  'quiet.typingSeconds': [5, 600],
};

/** The keys each section may carry (anything else is an error: a typo must not pass silently). */
const SHAPE: Record<string, readonly string[]> = {
  snapshot: ['enabled', 'idleMinutes', 'keep'],
  fetch: ['enabled', 'everyMinutes'],
  fastForward: ['enabled'],
  notify: ['enabled', 'dirtyAfterMinutes', 'behindAfterMinutes'],
  proposeCommit: ['enabled', 'idleMinutes'],
  quiet: ['typingSeconds'],
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type RulesResult = { ok: true; rules: LocalRules } | { ok: false; error: string };

/** Check a (partial) global document and fill it with the defaults. */
export function normalizeRules(input: unknown): RulesResult {
  const bad = (error: string): RulesResult => ({ ok: false, error });
  if (input === undefined || input === null) return { ok: true, rules: structuredClone(DEFAULT_RULES) };
  if (!isObject(input)) return bad('the rules must be an object');
  const out = structuredClone(DEFAULT_RULES) as unknown as Record<string, Record<string, unknown>>;
  for (const [key, value] of Object.entries(input)) {
    if (key === 'version') {
      if (value !== 1) return bad(`version ${String(value)} is not understood (this server writes version 1)`);
    } else if (key in SHAPE) {
      if (!isObject(value)) return bad(`${key} must be an object`);
      for (const [k, v] of Object.entries(value)) {
        if (!SHAPE[key]!.includes(k)) return bad(`${key}.${k} is not a known setting`);
        if (k === 'enabled') {
          if (typeof v !== 'boolean') return bad(`${key}.enabled must be true or false`);
        } else {
          const [min, max] = BOUNDS[`${key}.${k}`]!;
          if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return bad(`${key}.${k} must be a whole number between ${min} and ${max}`);
        }
        out[key]![k] = v;
      }
    } else if (key === 'ignore') {
      if (!Array.isArray(value) || value.length > 50) return bad('ignore: a list of at most 50 patterns');
      for (const p of value) {
        if (typeof p !== 'string' || p.length < 1 || p.length > 200) return bad('ignore: a pattern must be 1–200 characters');
        if (p.startsWith('/') || p.includes('..')) return bad(`ignore: "${p}" must be a relative pattern without ..`);
        if ([...p].some((c) => c.charCodeAt(0) < 32)) return bad(`ignore: "${p}" has a control character`);
      }
      out.ignore = [...new Set(value as string[])] as never;
    } else if (key === 'projectCanEnable') {
      if (!Array.isArray(value)) return bad('projectCanEnable must be a list');
      for (const n of value) if (!(RULE_NAMES as readonly unknown[]).includes(n)) return bad(`projectCanEnable: unknown rule "${String(n)}" (known: ${RULE_NAMES.join(', ')})`);
      out.projectCanEnable = [...new Set(value as string[])].sort() as never;
    } else {
      return bad(`"${key}" is not a known rule`);
    }
  }
  return { ok: true, rules: out as unknown as LocalRules };
}
