import { describe, expect, it } from 'vitest';
import { parseRepoUrl } from '../project-core';
import { classifyGitFailure, makeTokenRedactor, parseLsRemote, summarizeReport, tokenForms, urlAuthProblem, type FailureKind, type RepoTestReport, type RepoTestStepId } from './repo-test-core';

const gh = { provider: 'github' as const, protocol: 'https' as const };

describe('classifyGitFailure — the table', () => {
  const rows: Array<[string, FailureKind, RepoTestStepId, Partial<Parameters<typeof classifyGitFailure>[1]>, RegExp]> = [
    ["fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", 'dns', 'network', { auth: 'token' }, /cannot be resolved/],
    ['ssh: Could not resolve hostname github.com: Name or service not known', 'dns', 'network', { auth: 'ssh', protocol: 'ssh' }, /DNS/],
    ["fatal: unable to access 'https://x/': Failed to connect to x port 443 after 15000 ms: Timed out", 'timeout', 'network', { auth: 'token' }, /timed out/],
    ['ssh: connect to host github.com port 22: Connection timed out', 'timeout', 'network', { auth: 'ssh', protocol: 'ssh' }, /timed out/],
    ['ssh: connect to host git.corp port 22: Connection refused', 'connection', 'network', { auth: 'ssh', protocol: 'ssh', provider: 'generic' }, /no connection/],
    ['remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for', 'bad-token', 'auth', { auth: 'token' }, /rejected the token/],
    ['remote: HTTP Basic: Access denied. The provided password or token is incorrect', 'bad-token', 'auth', { auth: 'token', provider: 'gitlab' }, /GitLab rejected the token/],
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'bad-token', 'auth', { auth: 'none' }, /not public/],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'key-rejected', 'auth', { auth: 'ssh', protocol: 'ssh' }, /did not accept the SSH key/],
    ['Load key "/secrets/projects/a/id_ed25519": invalid format', 'key-rejected', 'auth', { auth: 'ssh', protocol: 'ssh' }, /SSH key/],
    ['ERROR: Repository not found.\nfatal: Could not read from remote repository.', 'not-found', 'auth', { auth: 'ssh', protocol: 'ssh' }, /does not exist/],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", 'not-found', 'auth', { auth: 'token' }, /does not exist/],
    ['remote: The project you were looking for could not be found or you don\'t have permission to view it.', 'not-found', 'auth', { auth: 'token', provider: 'gitlab' }, /does not exist/],
    ['@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.', 'host-key-changed', 'auth', { auth: 'ssh', protocol: 'ssh' }, /does not match the one pinned/],
    ['No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.', 'host-key-changed', 'auth', { auth: 'ssh', protocol: 'ssh' }, /host key/],
    ['fatal: Remote branch develop not found in upstream origin', 'branch-missing', 'branch', { auth: 'token' }, /branch does not exist/],
    ['ERROR: The key you are authenticating with has been marked as read only.', 'read-only', 'write', { auth: 'ssh', protocol: 'ssh', phase: 'write' }, /pushing is not allowed/],
    ['remote: Write access to repository not granted.\nfatal: unable to access \'https://github.com/o/r.git/\': The requested URL returned error: 403', 'read-only', 'write', { auth: 'token', phase: 'write' }, /pushing is not allowed/],
    ["fatal: unable to access 'https://git.corp/': SSL certificate problem: unable to get local issuer certificate", 'connection', 'network', { auth: 'token', provider: 'generic' }, /certificate/],
    ['git is not installed (or not on PATH)', 'no-git', 'url', { auth: 'none' }, /not installed/],
    ['sh: 1: ssh -i /x: ssh: not found\nfatal: Could not read from remote repository.', 'no-ssh', 'network', { auth: 'ssh' }, /SSH client/],
    ['fatal: something nobody has seen before', 'unknown', 'auth', { auth: 'none' }, /git failed: fatal: something/],
  ];
  for (const [text, kind, step, ctx, msg] of rows) {
    it(`${kind}: ${text.split('\n')[0]!.slice(0, 60)}`, () => {
      const c = classifyGitFailure(text, { ...gh, auth: 'none', phase: 'read', ...ctx });
      expect(c.kind).toBe(kind);
      expect(c.step).toBe(step);
      expect(c.message).toMatch(msg);
      if (kind !== 'unknown') expect(c.hint).toBeTruthy();
    });
  }

  it('a timeout flag wins over the text', () => {
    expect(classifyGitFailure('', { ...gh, auth: 'token', phase: 'read', timedOut: true }).kind).toBe('timeout');
  });

  it('hints name the provider UI for keys and tokens', () => {
    expect(classifyGitFailure('Permission denied (publickey).', { provider: 'gitlab', protocol: 'ssh', auth: 'ssh', phase: 'read' }).hint).toMatch(/Settings → Repository → Deploy keys/);
    expect(classifyGitFailure('Permission denied (publickey).', { provider: 'bitbucket', protocol: 'ssh', auth: 'ssh', phase: 'read' }).hint).toMatch(/Access keys/);
    expect(classifyGitFailure('Authentication failed', { provider: 'github', protocol: 'https', auth: 'token', phase: 'read' }).hint).toMatch(/Personal access tokens/);
  });
});

describe('parseLsRemote', () => {
  it('reads the symbolic HEAD, the heads and notices an empty remote', () => {
    const info = parseLsRemote(['ref: refs/heads/main\tHEAD', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/dev', ''].join('\n'));
    expect(info.defaultBranch).toBe('main');
    expect(info.branches).toEqual(['dev', 'main']);
    expect(info.heads.main).toBe('a'.repeat(40));
    expect(info.empty).toBe(false);
    expect(parseLsRemote('')).toEqual({ defaultBranch: null, branches: [], heads: {}, empty: true });
  });
});

describe('urlAuthProblem', () => {
  it('token needs https, ssh needs an ssh URL, none takes anything', () => {
    expect(urlAuthProblem(parseRepoUrl('https://github.com/o/r.git'), 'token')).toBeNull();
    expect(urlAuthProblem(parseRepoUrl('git@github.com:o/r.git'), 'token')).toMatch(/needs an https:\/\/ URL.*https:\/\/github.com\/o\/r.git/);
    expect(urlAuthProblem(parseRepoUrl('ssh://git@github.com/o/r.git'), 'token')).toMatch(/needs an https/);
    expect(urlAuthProblem(parseRepoUrl('http://git.corp/o/r.git'), 'token')).toMatch(/plain http/);
    expect(urlAuthProblem(parseRepoUrl('https://github.com/o/r.git'), 'ssh')).toMatch(/needs an ssh URL \(git@github.com:o\/r.git/);
    expect(urlAuthProblem(parseRepoUrl('git@github.com:o/r.git'), 'ssh')).toBeNull();
    expect(urlAuthProblem(parseRepoUrl('ssh://git@gitlab.com:2222/o/r.git'), 'ssh')).toBeNull();
    expect(urlAuthProblem(parseRepoUrl('file:///tmp/x.git'), 'none')).toBeNull();
    expect(urlAuthProblem(parseRepoUrl('git@github.com:o/r.git'), 'none')).toBeNull();
    expect(urlAuthProblem(null, 'none')).toMatch(/not set or not valid/);
  });
});

describe('token redaction', () => {
  it('removes the raw token and its base64 Basic form from text', () => {
    const token = 'ghp_' + 'SECRETsecret1234'; // assembled: a scanner would take a literal for a leaked token
    const redact = makeTokenRedactor(token);
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    expect(tokenForms(token)).toEqual([token, basic]);
    const text = `fatal: AUTHORIZATION: Basic ${basic} and ${token} again ${token}`;
    const out = redact(text);
    expect(out).not.toContain(token);
    expect(out).not.toContain(basic);
    expect(out).toBe('fatal: AUTHORIZATION: Basic *** and *** again ***');
    expect(makeTokenRedactor(null)('keep')).toBe('keep');
    expect(makeTokenRedactor('')('keep')).toBe('keep');
  });
});

describe('summarizeReport', () => {
  const base = (steps: RepoTestReport['steps'], ok = true, defaultBranch?: string): RepoTestReport => ({ ok, provider: 'github', steps, durationMs: 1, ...(defaultBranch ? { defaultBranch } : {}) });
  it('says ok + default branch + write state, or names the failed step', () => {
    expect(summarizeReport(base([{ id: 'write', label: 'Write access', ok: true, detail: '' }], true, 'main'))).toBe('ok (default branch main), write access confirmed');
    expect(summarizeReport(base([{ id: 'write', label: 'Write access', ok: false, detail: '' }], true))).toBe('ok, read-only');
    expect(summarizeReport(base([{ id: 'url', label: 'Repository URL', ok: true, detail: '' }, { id: 'auth', label: 'Access (authentication)', ok: false, detail: 'GitHub rejected the token' }], false))).toBe('Access (authentication): GitHub rejected the token');
  });
});
