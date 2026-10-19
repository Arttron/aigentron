import { describe, expect, it } from 'vitest';
import { defaultProjectPatch } from './settings.service';

/** The legacy Settings → General fields are the default project's: a write there lands on the Project row too. */
describe('defaultProjectPatch', () => {
  it('maps only the keys present, normalising like the projects API does', () => {
    expect(defaultProjectPatch({})).toEqual({});
    expect(defaultProjectPatch({ concurrency: 3, debugMode: true })).toEqual({});
    expect(defaultProjectPatch({ repoUrl: ' https://github.com/a/b ', repoBranch: 'develop', workspaceSubdir: '/apps/api/', githubToken: 'ghp_x' })).toEqual({
      repoUrl: 'https://github.com/a/b',
      repoBranch: 'develop',
      repoSubdir: 'apps/api',
      repoAuth: 'token',
    });
    expect(defaultProjectPatch({ repoUrl: null, githubToken: null, workspaceSubdir: '../x', verifyCommands: ' pnpm test\r\n', verifyMaxAttempts: 4 })).toEqual({
      repoUrl: null,
      repoAuth: 'none',
      repoSubdir: null,
      verifyCommands: 'pnpm test',
      verifyMaxAttempts: 4,
    });
    expect(defaultProjectPatch({ defaultAgent: ' pm ', notifyChannelId: '', notifyChatId: '42' })).toEqual({ defaultAgent: 'pm', notifyChannelId: null, notifyChatId: '42' });
    // a blank branch is not a branch: left alone
    expect(defaultProjectPatch({ repoBranch: '  ' })).toEqual({});
  });
  it('never carries the token itself', () => {
    expect(JSON.stringify(defaultProjectPatch({ githubToken: 'ghp_secret' }))).not.toContain('ghp_secret');
  });
});
