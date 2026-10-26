/**
 * What a shell command DOES, read from its text: which git / gh operations it runs, and which paths it writes, moves or deletes. Pure — the classifier
 * decides what that means (a merge, an action on main / master, something outside the working directory, a protected file).
 *
 * It is a reader of commands, not a shell: it follows quotes, `;` `&&` `||` `|` and newlines, heredocs, `cd`, wrappers (`sudo`, `env`, `nohup`, `xargs` …),
 * `sh -c "…"`, `$( … )`, and understands the common writers (rm, mv, cp, tee, redirections, sed -i, find -delete, curl -o, tar -C, dd of=, git clone …).
 * A path it cannot know (`$HOME/x`, `$(pwd)/x`, `~/x`) counts as outside. What it does not read (a script file, an interpreter's own code beyond a few
 * obvious calls) it cannot judge.
 */

export interface ShellFacts {
  /** `git merge …` / `gh pr merge` / an API call that merges a pull request */
  merge: boolean;
  /** a git operation that changes or brings in `main` / `master` (or cannot be told from one) */
  mainBranch: boolean;
  /** paths the command writes, moves or deletes, as typed (relative ones are resolved against the directory in force when they run) */
  mutated: { path: string; /** the directory in force (null = unknown after a `cd` into something unreadable) */ cwd: string | null; dynamic: boolean }[];
}

interface Tok {
  text: string;
  /** contained `$…`, a backtick or `~` that the shell would expand (outside single quotes) */
  dynamic: boolean;
  /** was quoted somewhere (so it is not an operator) */
  quoted: boolean;
}

const MAIN = /^(main|master)$/i;

/** Split on `;` `&&` `||` `|` `&` and newlines outside quotes; drop heredoc bodies; join `\`-newline continuations. */
export function splitCommands(src: string): string[] {
  const text = src.replace(/\\\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  let heredoc: { word: string; strip: boolean } | null = null;
  const lines = text.split('\n');
  const pushCur = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (const line of lines) {
    if (heredoc) {
      if ((heredoc.strip ? line.trim() : line) === heredoc.word) heredoc = null;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (q) {
        if (c === '\\' && q === '"') {
          cur += c + (line[++i] ?? '');
          continue;
        }
        if (c === q) q = null;
        cur += c;
        continue;
      }
      if (c === '\\') {
        cur += c + (line[++i] ?? '');
        continue;
      }
      if (c === '"' || c === "'") {
        q = c;
        cur += c;
        continue;
      }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) break; // a comment
      if (c === ';' || c === '|' || c === '&') {
        // `2>&1`, `&>file`, `>&2`: part of a redirection
        if (c === '&' && (line[i - 1] === '>' || line[i + 1] === '>')) {
          cur += c;
          continue;
        }
        pushCur();
        if ((c === '&' || c === '|') && line[i + 1] === c) i++;
        continue;
      }
      if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const m = /^<<(-?)\s*(?:'([^']+)'|"([^"]+)"|(\w+))/.exec(line.slice(i));
        if (m) heredoc = { word: m[2] ?? m[3] ?? m[4]!, strip: m[1] === '-' };
      }
      cur += c;
    }
    if (!q) pushCur();
    else cur += '\n';
  }
  pushCur();
  return out;
}

/** Words of one simple command, quotes removed; redirection operators become their own tokens (`>`, `>>`, `2>` …). */
export function tokenize(cmd: string): Tok[] {
  const toks: Tok[] = [];
  let cur = '';
  let dyn = false;
  let quoted = false;
  let started = false;
  const push = () => {
    if (started) toks.push({ text: cur, dynamic: dyn, quoted });
    cur = '';
    dyn = false;
    quoted = false;
    started = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "'") {
      started = quoted = true;
      const end = cmd.indexOf("'", i + 1);
      const stop = end < 0 ? cmd.length : end;
      cur += cmd.slice(i + 1, stop);
      i = stop;
      continue;
    }
    if (c === '"') {
      started = quoted = true;
      i++;
      for (; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\' && i + 1 < cmd.length) {
          cur += cmd[++i];
          continue;
        }
        if (cmd[i] === '$' || cmd[i] === '`') dyn = true;
        cur += cmd[i];
      }
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) {
      started = true;
      cur += cmd[++i];
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === '>' || c === '<') {
      // a redirection: `>`, `>>`, `>|`, `&>`, `2>`, `2>>`; the digits / `&` just before belong to it
      const prev = /^(\d+|&)$/.test(cur) ? cur : '';
      if (prev) cur = '';
      else push();
      let op = prev + c;
      while (cmd[i + 1] === '>' || cmd[i + 1] === '|') op += cmd[++i];
      toks.push({ text: op, dynamic: false, quoted: false });
      started = false;
      continue;
    }
    started = true;
    if (c === '$' || c === '`' || (c === '~' && cur === '')) dyn = true;
    cur += c;
  }
  push();
  return toks;
}

const WRAPPERS = new Set(['sudo', 'time', 'nohup', 'command', 'exec', 'nice', 'ionice', 'stdbuf', 'timeout', 'doas', 'builtin', 'xargs', 'watch']);
const OPT_WITH_VALUE_GIT = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = /^(python3?|node(js)?|ruby|perl|php|deno|bun)$/;
const WRITE_ISH = /\b(open\s*\([^)]*['"][wax]|write_?file|writeFile|write_text|write_bytes|unlink|remove|rmtree|rmSync|rmdir|mkdir|makedirs|rename|copy|symlink|put_contents|fwrite|unlinkSync|appendFile)/i;

const isOption = (t: Tok): boolean => !t.quoted && t.text.startsWith('-') && t.text.length > 1;

/** Facts of a whole command line. `cwd` is the directory the command starts in (null = not known). */
export function analyzeShell(command: string, cwd: string | null, depth = 0): ShellFacts {
  const facts: ShellFacts = { merge: false, mainBranch: false, mutated: [] };
  if (depth > 4) return facts;
  let dir = cwd;
  const mut = (t: Tok | { text: string; dynamic: boolean }) => {
    if (!t.text || /^\/dev\/(null|stdout|stderr|stdin|tty|fd\/\d+)$/.test(t.text) || /^&\d$/.test(t.text)) return;
    facts.mutated.push({ path: t.text, cwd: dir, dynamic: t.dynamic });
  };
  // `$( … )` and backticks hold commands of their own
  const inner: string[] = [];
  const flat = command.replace(/\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g, (_m, a: string | undefined, b: string | undefined) => {
    inner.push((a ?? b) || '');
    return ' $SUB ';
  });
  for (const sub of inner) merge(facts, analyzeShell(sub, dir, depth + 1));

  for (const simple of splitCommands(flat)) {
    let toks = tokenize(simple);
    // redirections write: the word after `>` / `>>` / `&>` …
    const words: Tok[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (!t.quoted && /^(\d*|&)>+\|?$/.test(t.text)) {
        const target = toks[i + 1];
        if (target) mut(target);
        i++;
      } else if (!t.quoted && /^(\d*|&)<+$/.test(t.text)) {
        i++; // an input redirection reads
      } else words.push(t);
    }
    toks = words;
    // leading VAR=value, then wrappers
    let i = 0;
    while (i < toks.length && /^[A-Za-z_]\w*=/.test(toks[i]!.text)) i++;
    while (i < toks.length && (WRAPPERS.has(toks[i]!.text) || toks[i]!.text === 'env')) {
      const w = toks[i]!.text;
      i++;
      // `env A=b cmd`, `sudo -u x cmd`, `timeout 5 cmd`: skip the wrapper's own options and assignments
      while (i < toks.length && (isOption(toks[i]!) || /^[A-Za-z_]\w*=/.test(toks[i]!.text) || (w === 'timeout' && /^\d/.test(toks[i]!.text)))) {
        if (w === 'sudo' && /^-(u|g|h|p|C|T|U|r|t)$/.test(toks[i]!.text)) i++;
        i++;
      }
    }
    const verb = toks[i]?.text ?? '';
    const args = toks.slice(i + 1);
    if (!verb) continue;
    const operands = args.filter((t) => !isOption(t));
    const bare = verb.replace(/^.*\//, '');

    if (bare === 'cd' || bare === 'pushd') {
      const t = operands[0];
      if (!t) dir = cwd;
      else if (t.dynamic || t.text === '-') dir = null;
      else dir = dir === null && !t.text.startsWith('/') ? null : resolve(t.text, dir);
      continue;
    }
    if (SHELLS.has(bare)) {
      const c = args.findIndex((t) => t.text === '-c' || /^-[a-z]*c$/.test(t.text));
      if (c >= 0 && args[c + 1]) merge(facts, analyzeShell(args[c + 1]!.text, dir, depth + 1));
      continue;
    }
    if (bare === 'eval' && operands.length) {
      merge(facts, analyzeShell(operands.map((t) => t.text).join(' '), dir, depth + 1));
      continue;
    }
    if (bare === 'git') gitFacts(facts, args, mut, dir);
    else if (bare === 'gh') ghFacts(facts, args);
    else if (['rm', 'rmdir', 'unlink', 'shred', 'touch', 'mkdir', 'chmod', 'chown', 'chgrp', 'truncate', 'tee', 'mv'].includes(bare)) {
      // chmod / chown take a mode or owner first
      const list = bare === 'chmod' || bare === 'chown' || bare === 'chgrp' ? operands.slice(1) : operands;
      list.forEach(mut);
    } else if (['cp', 'ln', 'install', 'rsync', 'scp'].includes(bare)) {
      const t = args.findIndex((a) => a.text === '-t' || a.text === '--target-directory');
      if (t >= 0 && args[t + 1]) mut(args[t + 1]!);
      else if (operands.length) mut(operands[operands.length - 1]!); // the destination; reading the sources is free
    } else if (bare === 'dd') {
      for (const a of args) if (a.text.startsWith('of=')) mut({ text: a.text.slice(3), dynamic: a.dynamic });
    } else if (bare === 'sed' || bare === 'perl') {
      if (args.some((a) => /^-[a-z]*i/.test(a.text) || a.text === '--in-place' || a.text.startsWith('--in-place='))) operands.slice(1).forEach(mut);
    } else if (bare === 'find') {
      if (args.some((a) => a.text === '-delete' || a.text === '-fprint' || (a.text === '-exec' && /^(rm|mv|shred|unlink)$/.test(args[args.indexOf(a) + 1]?.text ?? '')))) {
        for (const a of args) {
          if (isOption(a) || a.text === '(' || a.text === '!') break;
          mut(a);
        }
      }
    } else if (bare === 'curl' || bare === 'wget') {
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!.text;
        if (/^(-o|--output|-O|--output-document|--output-dir|-P|--directory-prefix)$/.test(a) && !(bare === 'curl' && a === '-O') && args[k + 1]) mut(args[k + 1]!);
        else if (/^--(output|output-document|directory-prefix)=/.test(a)) mut({ text: a.split('=').slice(1).join('='), dynamic: args[k]!.dynamic });
      }
    } else if (bare === 'tar') {
      for (let k = 0; k < args.length; k++) if ((args[k]!.text === '-C' || args[k]!.text === '--directory') && args[k + 1]) mut(args[k + 1]!);
    } else if (bare === 'unzip') {
      for (let k = 0; k < args.length; k++) if (args[k]!.text === '-d' && args[k + 1]) mut(args[k + 1]!);
    } else if (INTERPRETERS.test(bare)) {
      const c = args.findIndex((t) => /^(-c|-e|-p|--eval|-r)$/.test(t.text));
      const code = c >= 0 ? args[c + 1]?.text : undefined;
      if (code && WRITE_ISH.test(code)) {
        for (const m of code.matchAll(/['"]((?:~|\/)[^'"\s]*)['"]/g)) mut({ text: m[1]!, dynamic: false });
      }
    }
  }
  return facts;
}

function merge(into: ShellFacts, from: ShellFacts): void {
  into.merge ||= from.merge;
  into.mainBranch ||= from.mainBranch;
  into.mutated.push(...from.mutated);
}

function resolve(p: string, base: string | null): string {
  const abs = p.startsWith('/') ? p : `${(base ?? '').replace(/\/$/, '')}/${p}`;
  const segs: string[] = [];
  for (const s of abs.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') segs.pop();
    else segs.push(s);
  }
  return `/${segs.join('/')}`;
}

/** `git merge agent/task-…` (only such refs) while the shell is inside a task worktree. */
function ownTaskMerge(operands: Tok[], dir: string | null): boolean {
  return !!dir && /[\\/]worktrees[\\/]/.test(dir) && operands.length > 0 && operands.every((t) => !t.dynamic && /^agent\/task-[\w-]+$/.test(t.text));
}

/** A ref the way a person writes it (`origin/main`, `HEAD:main`, `+refs/heads/main`, `refs/remotes/origin/master`) → is it main or master? */
export function isMainRef(raw: string): boolean {
  return raw
    .replace(/^\+/, '')
    .split(':')
    .some((part) => MAIN.test(part.replace(/^refs\/(heads|remotes\/[^/]+)\//, '').replace(/^(origin|upstream)\//i, '')));
}

function gitFacts(facts: ShellFacts, args: Tok[], mut: (t: Tok) => void, dir: string | null): void {
  let i = 0;
  while (i < args.length && isOption(args[i]!)) {
    const o = args[i]!.text;
    i += OPT_WITH_VALUE_GIT.has(o) ? 2 : 1;
  }
  const sub = args[i]?.text ?? '';
  const rest = args.slice(i + 1);
  const operands = rest.filter((t) => !isOption(t));
  const flags = new Set(rest.filter(isOption).map((t) => t.text));
  const anyMain = operands.some((t) => isMainRef(t.text));
  const unknownRef = operands.some((t) => t.dynamic);
  switch (sub) {
    case 'merge':
      // an agent's own task branches merged inside a task worktree are routine (the branch they land in is not main there)
      if (!flags.has('--abort') && !flags.has('--quit') && !ownTaskMerge(operands, dir)) facts.merge = true;
      if (anyMain) facts.mainBranch = true;
      break;
    case 'push':
      if (anyMain || unknownRef || flags.has('--all') || flags.has('--mirror') || [...flags].some((f) => /^--(delete)$/.test(f) && anyMain)) facts.mainBranch = true;
      break;
    case 'pull':
      // fetch + merge (unless it rebases)
      if (!flags.has('--rebase') && !flags.has('-r') && !flags.has('--ff-only')) facts.merge = true;
      if (anyMain) facts.mainBranch = true;
      break;
    case 'reset':
    case 'cherry-pick':
    case 'revert':
    case 'update-ref':
    case 'tag':
      if (anyMain || (unknownRef && (sub === 'reset' || sub === 'update-ref'))) facts.mainBranch = true;
      break;
    case 'branch': {
      // deleting / renaming / force-moving main; `git branch feature main` only starts from it
      const changes = [...flags].some((f) => /^--(delete|move|force)$/.test(f) || (/^-[a-zA-Z]+$/.test(f) && /[dDmMf]/.test(f)));
      if (changes && anyMain) facts.mainBranch = true;
      break;
    }
    case 'checkout':
    case 'switch': {
      const forced = flags.has('-B') || flags.has('-C');
      const creates = forced || flags.has('-b') || flags.has('-c');
      const first = operands[0]?.text ?? '';
      if (creates) {
        if (forced && MAIN.test(first)) facts.mainBranch = true; // re-pointing main
      } else if (!rest.some((t) => t.text === '--') && MAIN.test(first)) {
        facts.mainBranch = true; // moving onto main (`origin/main` is a different thing: a detached look)
      }
      break;
    }
    case 'fetch':
      // `git fetch origin main:main` overwrites the local main
      if (operands.some((t) => /:(main|master)$/i.test(t.text.replace(/^\+/, '')))) facts.mainBranch = true;
      break;
    case 'clone': {
      const dest = operands.length >= 2 ? operands[operands.length - 1] : undefined;
      if (dest) mut(dest);
      break;
    }
    case 'config':
      break;
    default:
      break;
  }
}

function ghFacts(facts: ShellFacts, args: Tok[]): void {
  const words = args.filter((t) => !isOption(t)).map((t) => t.text);
  if (words[0] === 'pr' && words[1] === 'merge') facts.merge = true;
  if (words[0] === 'api' && words.some((w) => /\/pulls\/\d+\/merge\b/.test(w))) facts.merge = true;
}
