import { describe, expect, it } from 'vitest';
import { CLI_RUNTIMES, cliDirOf, isCliRuntimeKind, localBinPath, npmInstallArgs } from './runtime-registry';

describe('cli runtime registry', () => {
  it('pins Codex to an exact version and builds a fixed npm command', () => {
    expect(CLI_RUNTIMES.codex.version).toMatch(/^\d+\.\d+\.\d+$/);
    const args = npmInstallArgs('/data/cli', CLI_RUNTIMES.codex);
    expect(args.slice(0, 3)).toEqual(['install', '--prefix', '/data/cli']);
    expect(args.at(-1)).toBe(`@openai/codex@${CLI_RUNTIMES.codex.version}`);
    expect(args.every((a) => !/[;&|$`]/.test(a))).toBe(true);
  });
  it('the cli dir sits next to the secrets dir unless CLI_DIR says otherwise', () => {
    expect(cliDirOf('/opt/aigentron/data/secrets', {})).toBe('/opt/aigentron/data/cli');
    expect(cliDirOf('/x/secrets', { CLI_DIR: '/mnt/big/cli' })).toBe('/mnt/big/cli');
    expect(localBinPath('/data/cli', CLI_RUNTIMES.codex)).toBe('/data/cli/node_modules/.bin/codex');
  });
  it('only registered kinds are installable', () => {
    expect(isCliRuntimeKind('codex')).toBe(true);
    expect(isCliRuntimeKind('claude')).toBe(false);
    expect(isCliRuntimeKind('rm -rf')).toBe(false);
  });
});
