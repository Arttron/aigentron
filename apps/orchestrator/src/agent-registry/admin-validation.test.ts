import { describe, expect, it } from 'vitest';
import { validateProviderProposal, validateSettingsChanges } from './admin-validation';

const ok = { name: 'main', kind: 'anthropic', model: 'claude-x', authMode: 'api-key', reason: 'r' };

describe('validateProviderProposal', () => {
  it('accepts a sane proposal', () => expect(validateProviderProposal(ok)).toBeNull());
  it('rejects bad names, kinds and auth modes', () => {
    expect(validateProviderProposal({ ...ok, name: 'a b' })).toMatch(/name/);
    expect(validateProviderProposal({ ...ok, kind: 'foo' })).toMatch(/kind/);
    expect(validateProviderProposal({ ...ok, authMode: 'codex-login' })).toMatch(/authMode/);
    expect(validateProviderProposal({ ...ok, kind: 'codex', authMode: 'api-key' })).toBeNull();
  });
  it('rejects URLs with credentials, non-http schemes, and a codex base URL', () => {
    expect(validateProviderProposal({ ...ok, baseUrl: 'https://u:p@host/v1' })).toMatch(/credentials/);
    expect(validateProviderProposal({ ...ok, baseUrl: 'file:///etc/passwd' })).toMatch(/http/);
    expect(validateProviderProposal({ ...ok, baseUrl: 'nonsense' })).toMatch(/valid URL/);
    expect(validateProviderProposal({ ...ok, kind: 'codex', authMode: 'codex-login', baseUrl: 'https://x' })).toMatch(/codex/);
  });
});

describe('validateSettingsChanges', () => {
  it('requires at least one known key', () => {
    expect(validateSettingsChanges({})).toMatch(/at least one/);
    expect(validateSettingsChanges({ githubToken: 'x' })).toMatch(/can't be changed/);
  });
  it('range-checks numbers', () => {
    expect(validateSettingsChanges({ concurrency: 0 })).toMatch(/concurrency/);
    expect(validateSettingsChanges({ concurrency: 2 })).toBeNull();
    expect(validateSettingsChanges({ approvalTimeoutSeconds: 5 })).toMatch(/approvalTimeoutSeconds/);
  });
  it('workspaceSubdir must be a relative folder', () => {
    for (const bad of ['/abs', '../up', 'a/../b', 'https://x', 'git@host:x', 'a b']) {
      expect(validateSettingsChanges({ workspaceSubdir: bad }), bad).toMatch(/workspaceSubdir/);
    }
    expect(validateSettingsChanges({ workspaceSubdir: 'apps/web' })).toBeNull();
    expect(validateSettingsChanges({ workspaceSubdir: '' })).toBeNull();
  });
  it('repoBranch must be a plain branch name', () => {
    expect(validateSettingsChanges({ repoBranch: 'a..b' })).toMatch(/repoBranch/);
    expect(validateSettingsChanges({ repoBranch: 'feature/x' })).toBeNull();
  });
});
