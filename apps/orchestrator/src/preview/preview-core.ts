/**
 * Pure helpers of the preview server's safety checks: who listens on a port, and is that process ours. No I/O here (the service runs `lsof` / `ss` / `ps`
 * and hands the text over), so everything is unit-tested.
 */

/** Pids from `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` (lines `p1234`). */
export function parseLsofPids(out: string): number[] {
  return [...new Set(out.split('\n').map((l) => /^p(\d+)$/.exec(l.trim())?.[1]).filter((x): x is string => !!x).map(Number))];
}

/** Pids from `ss -ltnpH sport = :<port>` (`users:(("node",pid=1234,fd=19))`). */
export function parseSsPids(out: string): number[] {
  return [...new Set([...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
}

/** pid → parent pid, from `ps -A -o pid=,ppid=` (works on Linux, busybox and macOS). */
export function parsePsTable(out: string): Map<number, number> {
  const t = new Map<number, number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) t.set(Number(m[1]), Number(m[2]));
  }
  return t;
}

/** Is `pid` the root itself or one of its descendants (the dev server is a grandchild of the `sh` we started: sh → npm → node)? */
export function descendsFrom(pid: number, root: number, parentOf: ReadonlyMap<number, number>): boolean {
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    if (cur === root) return true;
    const next = parentOf.get(cur);
    if (next === undefined) return false;
    cur = next;
  }
  return cur === root;
}

/** The verdict on a port that has just started answering: ours, someone else's (with the pids), or not provable here (no tool to ask). */
export function portOwner(listeners: readonly number[] | null, root: number, parentOf: ReadonlyMap<number, number>): { kind: 'ours' } | { kind: 'foreign'; pids: number[] } | { kind: 'unknown' } {
  if (listeners === null || !listeners.length) return { kind: 'unknown' };
  const foreign = listeners.filter((p) => !descendsFrom(p, root, parentOf));
  return foreign.length === listeners.length ? { kind: 'foreign', pids: foreign } : { kind: 'ours' };
}
