import { join } from 'node:path';

/**
 * Agent runtimes that are separate command-line programs the server can install on demand (docs/provider-login.md). Claude's CLI ships
 * inside the Agent SDK, so only Codex needs installing; the version is pinned to what the Docker images bake in.
 */
export interface CliRuntime {
  kind: 'codex';
  label: string;
  /** npm package + exact version */
  pkg: string;
  version: string;
  /** the executable the package puts in node_modules/.bin */
  bin: string;
}

export const CLI_RUNTIMES: Readonly<Record<CliRuntime['kind'], CliRuntime>> = {
  codex: { kind: 'codex', label: 'Codex CLI', pkg: '@openai/codex', version: '0.160.1', bin: 'codex' },
};

export const isCliRuntimeKind = (k: string): k is CliRuntime['kind'] => k in CLI_RUNTIMES;

/** Where on-demand CLIs live: next to the secrets dir inside the data directory (CLI_DIR overrides). */
export function cliDirOf(secretsDir: string, env: Record<string, string | undefined> = process.env): string {
  return env.CLI_DIR?.trim() || join(secretsDir, '..', 'cli');
}

export const localBinPath = (cliDir: string, rt: CliRuntime): string => join(cliDir, 'node_modules', '.bin', rt.bin);

/** The npm command that installs a runtime into `cliDir` (pinned; nothing from a user ever reaches it). */
export function npmInstallArgs(cliDir: string, rt: CliRuntime): string[] {
  return ['install', '--prefix', cliDir, '--no-audit', '--no-fund', '--loglevel=error', '--save-exact', `${rt.pkg}@${rt.version}`];
}
