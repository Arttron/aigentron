/**
 * What a computer reports on its own (events `notice` and `propose-commit`, sent by the rules engine of the local agent) and what the server makes of it.
 * Everything here is data from another machine: it is parsed strictly, cut to size, and only ever put into a message or a task prompt as plain text.
 */

export interface Notice {
  repo: string;
  kind: 'dirty' | 'behind';
  branch: string;
  minutes: number;
  count: number;
}

export interface CommitProposal {
  repo: string;
  branch: string;
  files: Array<{ path: string; xy: string }>;
  idleMinutes: number;
}

const clean = (v: unknown, max: number): string =>
  typeof v === 'string'
    ? [...v]
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join('')
        .slice(0, max)
    : '';
const num = (v: unknown, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(max, Math.trunc(v))) : 0;

export function parseNotice(data: unknown): Notice | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  const repo = clean(d.repo, 64);
  if (!repo || (d.kind !== 'dirty' && d.kind !== 'behind')) return null;
  return {
    repo,
    kind: d.kind,
    branch: clean(d.branch, 200),
    minutes: num(d.minutes, 10_080 * 10),
    count: num(d.count, 1_000_000),
  };
}

export function parseProposal(data: unknown): CommitProposal | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  const repo = clean(d.repo, 64);
  if (!repo || !Array.isArray(d.files)) return null;
  const files = d.files
    .slice(0, 50)
    .map((f) => ({
      path: clean((f as { path?: unknown })?.path, 300),
      xy: clean((f as { xy?: unknown })?.xy, 2),
    }))
    .filter((f) => f.path);
  if (!files.length) return null;
  return { repo, branch: clean(d.branch, 200), files, idleMinutes: num(d.idleMinutes, 1440) };
}

const hours = (min: number): string => (min >= 120 ? `${Math.round(min / 60)} h` : `${min} min`);

export function noticeText(n: Notice, ctx: { project: string; computer: string }): string {
  const where = `«${ctx.project}» on ${ctx.computer}${n.branch ? ` (branch ${n.branch})` : ''}`;
  return n.kind === 'dirty'
    ? `📝 ${where}: ${n.count} changed file(s) have been uncommitted for ${hours(n.minutes)}. Commit or stash them so the work is safe.`
    : `⬇️ ${where}: the branch has been ${n.count} commit(s) behind its remote for ${hours(n.minutes)}. Pull when you are ready.`;
}

/** The task that asks an agent to SUGGEST a commit. The agent only reads (the local-os tools of this version cannot write) and answers with a suggestion. */
export function proposalPrompt(p: CommitProposal, ctx: { computer: string }): string {
  const list = p.files.map((f) => `- ${f.xy.trim() || '?'} ${f.path}`).join('\n');
  return (
    `The person's changes on ${ctx.computer}${p.branch ? ` (branch ${p.branch})` : ''} have been uncommitted and untouched for ${hours(p.idleMinutes)}.\n\n` +
    `Changed files (names reported by the computer; XY is git's status code):\n${list}\n\n` +
    `Look at the real changes with the local-os tools (local_status, local_diff, local_read), then answer with:\n` +
    `1. a short summary of what changed and why it looks like one piece of work (or several);\n` +
    `2. if they are several, how to group the files into separate commits;\n` +
    `3. a commit message for each group (a one-line subject, an optional body).\n` +
    `Do NOT try to commit, stage, stash or change anything: only suggest. The person decides.`
  );
}
