import { splitCommands, stripDataHeredocs } from './shell-guard';

/**
 * Which shell commands are HEAVY: builds, test runs, installs, type checks — the ones that take a CPU core and hundreds of MB for minutes.
 * Heavy commands go through the server's command pipeline (one queue for every task, a limit on how many run at once, held while the machine is busy);
 * everything else (git, ls, cat, small scripts) runs straight away. A server that keeps running (a dev server, `--watch`) is neither: it cannot
 * be waited for, so it stays an ordinary background command.
 *
 * Decided by the text of the command only — cheap, no model, and the same answer in the hook and on the server.
 */
export type CommandWeight = 'heavy' | 'light' | 'long-running';

const PKG = /^(npm|pnpm|yarn|bun)$/;
/** package-manager subcommands that install or build */
const PKG_HEAVY = /^(install|i|ci|add|update|upgrade|build|test|t|lint|typecheck|check|compile|bundle|exec|dlx|rebuild|prune|dedupe|audit)$/;
/** `npm run <script>` — scripts whose name says they build / test */
const SCRIPT_HEAVY = /(^|[:\-_])(build|test|tests|lint|typecheck|type-check|check|compile|bundle|e2e|ci|verify|coverage|prisma|generate|migrate)([:\-_]|$)/i;
const SCRIPT_LONG = /(^|[:\-_])(dev|start|serve|watch|preview|storybook)([:\-_]|$)/i;
/** programs that are heavy whatever they are given */
const TOOLS = new Set([
  'tsc', 'vitest', 'jest', 'mocha', 'ava', 'webpack', 'rollup', 'esbuild', 'turbo', 'nx', 'lerna', 'playwright', 'cypress', 'pytest', 'tox', 'nox',
  'gradle', 'gradlew', 'mvn', 'mvnw', 'cmake', 'ninja', 'xcodebuild', 'ng', 'nest', 'prisma', 'eslint', 'next', 'vite', 'tsup', 'swc', 'mypy', 'ruff', 'sbt',
]);
const MAKE = /^(make|gmake)$/;
/** `tool <sub>`: heavy only for these subcommands */
const SUB: Record<string, RegExp> = {
  cargo: /^(build|test|check|clippy|bench|install|doc|fetch)$/,
  go: /^(build|test|vet|install|generate|mod)$/,
  dotnet: /^(build|test|publish|restore|pack)$/,
  docker: /^(build|buildx|pull|push)$/,
  pip: /^(install|download|wheel)$/,
  pip3: /^(install|download|wheel)$/,
  poetry: /^(install|build|update|lock)$/,
  uv: /^(sync|pip|build|lock)$/,
  bundle: /^(install|update|exec)$/,
  composer: /^(install|update|require)$/,
  swift: /^(build|test)$/,
  python: /^$/, // `python -m pytest` is handled below
  python3: /^$/,
  brew: /^(install|upgrade|update)$/,
  apt: /^(install|upgrade|update)$/,
  'apt-get': /^(install|upgrade|update)$/,
};
const WATCHY = /(^|\s)(--watch|-w|--serve|--hot|--dev)(\s|$)/;

/** subcommands of tools that only read (they are light even for a heavy program) */
const INFO = /(^|\s)(--version|-v|-V|--help|-h|version|help)(\s|$)/;

/** the first word that is not an option (or an option's value: `pnpm --filter pkg build`) */
function firstWord(words: readonly string[]): { word: string; at: number } {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (/^(--filter|-F|--prefix|-C|--workspace|--dir|--cwd|--cache|--registry)$/.test(w)) {
      i++;
      continue;
    }
    if (!w.startsWith('-')) return { word: w, at: i };
  }
  return { word: '', at: -1 };
}

/** wrappers that only change HOW a command runs: `timeout 600 pnpm build`, `nohup pnpm build &`, `corepack pnpm build`, `nice -n 5 …` */
const WRAPPERS = /^(?:(?:sudo|time|nohup|exec|command|corepack|stdbuf\s+-\S+|setsid|caffeinate)\s+|(?:timeout|nice|ionice)\s+(?:-\S+\s+)*(?:\d+[smhd]?\s+)?)/;

function weightOfOne(segment: string, depth = 0): CommandWeight {
  let t = segment.trim().replace(/&\s*$/, '').trim();
  for (let i = 0; i < 6; i++) {
    const next = t.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').replace(/^env\s+(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/, '').replace(WRAPPERS, '');
    if (next === t) break;
    t = next;
  }
  if (!t) return 'light';
  // `bash -c "pnpm build"`: judge the command inside
  const inner = depth < 3 ? /^(?:ba|z|da)?sh\s+(?:-\w*c\w*)\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(t) : null;
  if (inner) return commandWeight(inner[1] ?? inner[2] ?? '', depth + 1);
  const words = t.split(/\s+/);
  const prog = (words[0] ?? '').replace(/^.*\//, '');
  const rest = words.slice(1);
  if (INFO.test(` ${rest.join(' ')} `) && rest.length <= 2) return 'light';
  if (WATCHY.test(` ${rest.join(' ')} `) && !(PKG.test(prog) && !/--watch/.test(rest.join(' ')))) return 'long-running'; // `-w` is the workspace root for pnpm / yarn, not watch
  if (PKG.test(prog)) {
    const { word: sub, at } = firstWord(rest);
    const byScript = (script: string): CommandWeight => (/watch/i.test(script) ? 'long-running' : SCRIPT_HEAVY.test(script) ? 'heavy' : SCRIPT_LONG.test(script) ? 'long-running' : 'light');
    if (/^(run|run-script)$/.test(sub)) return byScript(firstWord(rest.slice(at + 1)).word);
    if (/^(start|dev|serve|watch)$/.test(sub)) return 'long-running';
    if (prog === 'yarn' && !sub) return 'heavy'; // bare `yarn` installs
    if (sub === 'workspace') return weightOfOne(`${prog} ${rest.slice(at + 2).join(' ')}`, depth + 1); // yarn workspace <name> <command…>
    if (sub === 'workspaces' || sub === 'foreach') return /\b(build|test|install|lint|tsc|check|compile)\b/.test(rest.join(' ')) ? 'heavy' : 'light';
    if (TOOLS.has(sub)) return weightOfOne(rest.slice(at).join(' '), depth + 1); // `pnpm vitest run`, `yarn tsc`
    if (PKG_HEAVY.test(sub)) return 'heavy';
    // `pnpm <script>` / `yarn <script>`: a script name
    return /^(pnpm|yarn|bun)$/.test(prog) && sub ? byScript(sub) : 'light';
  }
  if (prog === 'npx' || prog === 'bunx') {
    const tool = (rest.find((w) => !w.startsWith('-')) ?? '').replace(/^.*\//, '').replace(/@.*$/, '');
    if (!TOOLS.has(tool)) return 'light';
    const after = firstWord(rest.slice(rest.findIndex((w) => w.replace(/^.*\//, '').replace(/@.*$/, '') === tool) + 1)).word;
    if (/^(vite|next|ng|nest)$/.test(tool) && (!after || /^(dev|start|serve)$/.test(after)) && !(tool !== 'vite' && !after)) return 'long-running';
    return 'heavy';
  }
  if (TOOLS.has(prog)) {
    const sub = rest.find((w) => !w.startsWith('-')) ?? '';
    if (/^(vite|next|ng|nest|webpack|esbuild)$/.test(prog) && /^(dev|start|serve|watch)$/.test(sub)) return 'long-running';
    if (prog === 'vite' && !sub) return 'long-running'; // bare `vite` is the dev server
    if (prog === 'prisma' && !/^(generate|migrate|db|studio)$/.test(sub)) return 'light';
    if (prog === 'prisma' && sub === 'studio') return 'long-running';
    return 'heavy';
  }
  if (prog === 'docker' && rest[0] === 'compose') {
    const csub = rest.slice(1).find((w) => !w.startsWith('-')) ?? '';
    if (/^(build|pull)$/.test(csub)) return 'heavy';
    if (csub === 'up') return /(^|\s)--build(\s|$)/.test(rest.join(' ')) ? 'heavy' : /(^|\s)(-d|--detach)(\s|$)/.test(rest.join(' ')) ? 'light' : 'long-running';
    return /^(logs|watch)$/.test(csub) ? 'long-running' : 'light';
  }
  if (/^(?:\.\/)?(?:[\w.-]+\/)*(build|test|install|ci|check|release|deploy)[\w.-]*\.sh$/.test(prog)) return 'heavy';
  if (MAKE.test(prog)) return 'heavy';
  if (/^python3?$/.test(prog) && rest[0] === '-m') return /^(pytest|tox|nox|pip|build|mypy|ruff)$/.test(rest[1] ?? '') ? 'heavy' : 'light';
  const sub = SUB[prog];
  if (sub) return sub.test(rest.find((w) => !w.startsWith('-')) ?? '') ? 'heavy' : 'light';
  if (/^(bash|sh|zsh)$/.test(prog) && rest[0] !== '-c') return /(^|\/)(build|test|install|ci|check|release|deploy)[\w.-]*\.sh$/.test(rest[0] ?? '') ? 'heavy' : 'light';
  return 'light';
}

/** The weight of a whole command line: heavy if any part of it is heavy; long-running if a part keeps running (and none is heavy first). */
export function commandWeight(command: string, depth = 0): CommandWeight {
  let weight: CommandWeight = 'light';
  for (const part of splitCommands(stripDataHeredocs(command))) {
    // a subshell / group: look inside
    const w = weightOfOne(part.replace(/^[({\s]+/, '').replace(/[)}\s]+$/, ''), depth);
    if (w === 'long-running') return 'long-running';
    if (w === 'heavy') weight = 'heavy';
  }
  return weight;
}

export const isHeavyCommand = (command: string): boolean => commandWeight(command) === 'heavy';
