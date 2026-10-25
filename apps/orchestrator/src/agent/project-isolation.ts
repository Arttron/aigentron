/**
 * Project isolation (docs/plan-project-isolation.md, stage 1): every project's agents run as their OWN OS user, so one client's agents cannot read or
 * write another client's files. An OPTION, off by default, and only where the server can really do it. Pure decisions here; the service gathers the facts.
 */

/** The range project uids are taken from: far above real users and above the usual container ranges, no `/etc/passwd` entry needed (setpriv takes numbers). */
export const PROJECT_UID_BASE = 40000;
export const PROJECT_UID_LAST = 49999;

/** The next free uid in the range, given the ones projects already hold and any the system uses; null when the range is full. */
export function allocateProjectUid(taken: Iterable<number>, reserved: Iterable<number> = []): number | null {
  const used = new Set<number>([...taken, ...reserved]);
  for (let uid = PROJECT_UID_BASE; uid <= PROJECT_UID_LAST; uid++) if (!used.has(uid)) return uid;
  return null;
}

/** uids and gids that `/etc/passwd` and `/etc/group` already give out inside the project range (they must not be reused for a project). */
export function systemIdsInRange(passwd: string, group: string): number[] {
  const ids: number[] = [];
  for (const [text, col] of [[passwd, 2], [group, 2]] as const) {
    for (const line of text.split('\n')) {
      const n = Number(line.split(':')[col]);
      if (Number.isInteger(n) && n >= PROJECT_UID_BASE && n <= PROJECT_UID_LAST) ids.push(n);
    }
  }
  return [...new Set(ids)].sort((a, b) => a - b);
}

/** What the server knows about itself (gathered by the service; faked in tests). */
export interface IsolationFacts {
  platform: string;
  /** the orchestrator runs as root (only root can hand files to another user and run something as one) */
  isRoot: boolean;
  hasSetpriv: boolean;
  /** AGENT_RUN_AS_UID is set: the base isolation (agents are not root) this builds on */
  baseOn: boolean;
  /** why the base isolation is unusable right now, or null */
  baseBroken: string | null;
  /** how many uids of the range the system already uses (they are skipped, never reused) */
  rangeTakenBySystem: number;
  /** the live probe: two different project uids, one's private folder must be unreadable to the other. null = not run (an earlier check failed) */
  probe: { ok: boolean; detail: string } | null;
}

export interface IsolationSupport {
  supported: boolean;
  /** plain words, shown next to the switch, when not supported (null otherwise) */
  reason: string | null;
}

/** Can this server give every project its own OS user? The first thing that is missing is the reason. */
export function projectIsolationSupport(f: IsolationFacts): IsolationSupport {
  const no = (reason: string): IsolationSupport => ({ supported: false, reason });
  if (f.platform !== 'linux') return no(`it needs Linux (this server runs ${f.platform}); on other systems projects share one agent user`);
  if (!f.isRoot) return no('the server is not running as root, so it cannot hand files to another user or run an agent as one');
  if (!f.hasSetpriv) return no('the `setpriv` command (package util-linux) is missing');
  if (!f.baseOn) return no('agents are not isolated from the server yet: run `sudo aigentron harden` first (it sets AGENT_RUN_AS_UID), this builds on it');
  if (f.baseBroken) return no(`the basic agent isolation is not working: ${f.baseBroken}`);
  if (f.probe === null) return no('the isolation check could not run');
  if (!f.probe.ok) return no(`the file system on this server does not keep one user's folder private from another: ${f.probe.detail}`);
  return { supported: true, reason: null };
}

/** The numbers worth showing next to the switch: how many project users are used, how many fit. */
export const projectUidCapacity = (): number => PROJECT_UID_LAST - PROJECT_UID_BASE + 1;
