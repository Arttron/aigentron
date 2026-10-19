/**
 * GitAccessService against REAL git: local bare repositories as remotes (file://), the token header via GIT_CONFIG_*
 * env (never argv), the ssh command plumbing (a fake `ssh` on PATH records how git calls it), the legacy-token
 * migration and the connection test's steps / classification end to end.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../../config/app-config.service';
import type { SettingsService } from '../../settings/settings.service';
import type { ProjectsService, ProjectRow } from '../projects.service';
import { GitAccessError, GitAccessService } from './git-access.service';
import { GitRunError, runGit } from './git-runner';

let base: string;
let rows: ProjectRow[];
let settings: { githubToken: string | null };
let svc: GitAccessService;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** A bare repository with one commit on `main` (and `dev`), usable as file:// remote. */
function makeRemote(name: string, opts: { empty?: boolean } = {}): string {
  const bare = join(base, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  if (!opts.empty) {
    const work = join(base, `${name}-seed`);
    execFileSync('git', ['clone', '-q', bare, work], { stdio: 'ignore' });
    writeFileSync(join(work, 'README.md'), `# ${name}\n`);
    git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git(work, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    git(work, 'branch', 'dev');
    git(work, 'push', '-q', 'origin', 'main', 'dev');
    git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  }
  return bare;
}

function row(slug: string, patch: Partial<ProjectRow> = {}): ProjectRow {
  const r = {
    id: `id_${slug}`, slug, name: slug, kind: 'code', isDefault: slug === 'default', repoUrl: null, repoBranch: 'main', repoSubdir: null, repoAuth: 'none', repoPath: null, isolation: null,
    verifyCommands: null, verifyMaxAttempts: 2, defaultAgent: null, notifyChannelId: null, notifyChatId: null, archivedAt: null, createdById: null, createdAt: new Date(), updatedAt: new Date(), ...patch,
  } as ProjectRow;
  rows.push(r);
  return r;
}

function fakeProjects(): ProjectsService {
  return {
    get: async (slug: string) => {
      const r = rows.find((x) => x.slug === slug);
      if (!r) throw new Error(`Project "${slug}" not found`);
      return r;
    },
    getDefault: async () => rows.find((x) => x.isDefault)!,
    update: async (slug: string, input: Record<string, unknown>) => {
      const r = rows.find((x) => x.slug === slug)!;
      const map: Record<string, string> = { repoUrl: 'repoUrl', repoBranch: 'repoBranch', repoSubdir: 'repoSubdir', repoAuth: 'repoAuth' };
      for (const [k, v] of Object.entries(input)) if (k in map && v !== undefined) (r as unknown as Record<string, unknown>)[map[k]!] = v;
      return r;
    },
    repoPathOf: (p: ProjectRow) => p.repoPath ?? join(base, 'projects', p.slug, 'repo'),
  } as unknown as ProjectsService;
}

function fakeSettings(): SettingsService {
  return {
    get: async () => ({ githubToken: settings.githubToken }),
    update: async (patch: { githubToken?: string | null }) => {
      if (patch.githubToken !== undefined) settings.githubToken = patch.githubToken;
      return { githubToken: settings.githubToken };
    },
  } as unknown as SettingsService;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lds-gitaccess-'));
  rows = [];
  settings = { githubToken: null };
  svc = new GitAccessService({ secretsDir: join(base, 'secrets'), agentRunAs: null } as AppConfigService, fakeProjects(), fakeSettings());
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const TOKEN = 'ghp_TESTtoken0123456789';
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');

describe('authFor', () => {
  it('none → anonymous, prompts off, no args', async () => {
    const a = await svc.authFor(row('p', { repoUrl: 'https://github.com/o/r.git' }));
    expect(a.anonymous).toBe(true);
    expect(a.args).toEqual([]);
    expect(a.env).toEqual({ GIT_TERMINAL_PROMPT: '0' });
    expect(a.redact('x')).toBe('x');
  });

  it('token → the http.extraHeader scheme in GIT_CONFIG_* env, nothing in args, a redactor', async () => {
    const p = row('p', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' });
    svc.store.writeToken('p', TOKEN);
    const a = await svc.authFor(p);
    expect(a.anonymous).toBe(false);
    expect(a.args).toEqual([]);
    expect(a.env.GIT_CONFIG_COUNT).toBe('2');
    expect(a.env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(a.env.GIT_CONFIG_VALUE_0).toBe('');
    expect(a.env.GIT_CONFIG_VALUE_1).toBe(`AUTHORIZATION: Basic ${BASIC}`);
    expect(JSON.stringify(a.env)).not.toContain(TOKEN); // only the base64 form, and only in env
    expect(a.redact(`x ${TOKEN} y ${BASIC}`)).toBe('x *** y ***');
  });

  it('token with an ssh / scp-like URL → a clear error; token without a file → a clear error', async () => {
    svc.store.writeToken('p', TOKEN);
    await expect(svc.authFor(row('p', { repoUrl: 'git@github.com:o/r.git', repoAuth: 'token' }))).rejects.toThrow(/needs an https:\/\/ URL/);
    await expect(svc.authFor(row('q', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' }))).rejects.toThrow(/no token is stored/);
  });

  it('apiTokenFor: the token of a TOKEN-access project only (the shared github MCP gets it per run); null for public / ssh / unknown', async () => {
    svc.store.writeToken('p', TOKEN);
    expect(await svc.apiTokenFor({ slug: 'p', repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' })).toBe(TOKEN);
    expect(await svc.apiTokenFor({ slug: 'p', repoUrl: 'https://github.com/o/r.git', repoAuth: 'none' })).toBeNull();
    expect(await svc.apiTokenFor({ slug: 'p', repoUrl: 'git@github.com:o/r.git', repoAuth: 'ssh' })).toBeNull();
    expect(await svc.apiTokenFor({ slug: 'nobody', repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' })).toBeNull();
  });

  it('the default project falls back to the legacy AppSettings token until it is migrated', async () => {
    settings.githubToken = TOKEN;
    const a = await svc.authFor(row('default', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' }));
    expect(a.env.GIT_CONFIG_VALUE_1).toContain(BASIC);
    await expect(svc.authFor(row('other', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' }))).rejects.toThrow(GitAccessError);
  });

  it('ssh → GIT_SSH_COMMAND with the project key + pinned known_hosts; no key → a clear error', async () => {
    const p = row('p', { repoUrl: 'git@github.com:o/r.git', repoAuth: 'ssh' });
    await expect(svc.authFor(p)).rejects.toThrow(/has no key yet/);
    await svc.setCredentials('p', { auth: 'ssh', action: 'generate' });
    const a = await svc.authFor(p);
    const keyPath = svc.store.pathOf('p', 'privateKey');
    const kh = svc.store.pathOf('p', 'knownHosts');
    expect(a.env.GIT_SSH_COMMAND).toBe(`ssh -i '${keyPath}' -o IdentitiesOnly=yes -o UserKnownHostsFile='${kh}' -o StrictHostKeyChecking=accept-new -o HashKnownHosts=no -o BatchMode=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=15 -o LogLevel=ERROR`);
    expect(existsSync(kh)).toBe(true);
    expect(a.anonymous).toBe(false);
    await expect(svc.authFor(row('h', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'ssh' }))).rejects.toThrow(/needs an ssh URL/);
  });

  it('none on an ssh URL still gets the pinned known_hosts and batch mode (no key)', async () => {
    const a = await svc.authFor(row('p', { repoUrl: 'git@github.com:o/r.git' }));
    expect(a.anonymous).toBe(true);
    expect(a.env.GIT_SSH_COMMAND).toMatch(/^ssh -o UserKnownHostsFile=/);
    expect(a.env.GIT_SSH_COMMAND).not.toContain('-i ');
  });
});

describe('the spawned git never sees the token in argv (env only) and errors are redacted', () => {
  it('argv is clean, env carries only the base64 header, the process list shows no token', async () => {
    const p = row('p', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' });
    svc.store.writeToken('p', TOKEN);
    const auth = await svc.authFor(p);
    // the alias runs in a shell whose parent is the git process itself → its argv is what `ps` shows
    const out = await runGit(['-c', 'alias.probe=!echo "ARGS:$(ps -o args= -p $PPID 2>/dev/null || echo ps-unavailable)"; env', 'probe'], { auth, cwd: base, timeoutMs: 20_000 });
    const argsLine = out.stdout.split('\n').find((l) => l.startsWith('ARGS:')) ?? '';
    expect(argsLine).not.toContain(TOKEN);
    expect(argsLine).not.toContain(BASIC);
    expect(argsLine).not.toContain('extraHeader');
    expect(out.stdout).toContain('GIT_CONFIG_KEY_1=http.extraHeader');
    // the raw token is nowhere; the redactor hides the base64 form in anything that comes back
    expect(out.stdout).not.toContain(TOKEN);
    expect(out.stdout).not.toContain(BASIC);
    expect(out.stdout).toContain('GIT_CONFIG_VALUE_1=AUTHORIZATION: Basic ***');
  });

  it('a git failure whose stderr echoes the token is redacted before it becomes an error', async () => {
    const p = row('p', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'token' });
    svc.store.writeToken('p', TOKEN);
    const auth = await svc.authFor(p);
    const err = await runGit(['-c', `alias.leak=!echo "fatal: bad ${TOKEN} / ${BASIC}" >&2; exit 128`, 'leak'], { auth, cwd: base }).catch((e: GitRunError) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(BASIC);
    expect(err.stderr).toContain('fatal: bad *** / ***');
    expect(err.code).toBe(128);
  });

  it('a hanging git is killed after the timeout', async () => {
    const err = await runGit(['-c', 'alias.hang=!sleep 30', 'hang'], { cwd: base, timeoutMs: 500 }).catch((e: GitRunError) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(err.timedOut).toBe(true);
    expect(err.message).toMatch(/timed out/);
  });
});

describe('credentials and status', () => {
  it('token: stored once as a file (0600), status shows only the hint, never the value; repoAuth follows', async () => {
    row('p', { repoUrl: 'https://github.com/o/r.git' });
    const s = await svc.setCredentials('p', { auth: 'token', token: ` ${TOKEN} ` });
    expect(s.auth).toBe('token');
    expect(s.tokenSet).toBe(true);
    expect(s.tokenHint).toBe('…6789');
    expect(s.provider).toBe('github');
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(readFileSync(svc.store.pathOf('p', 'token'), 'utf8')).toBe(`${TOKEN}\n`);
    expect(svc.store.modes('p')).toMatchObject({ '.': 0o700, token: 0o600 });
    await expect(svc.setCredentials('p', { auth: 'token', token: '' })).rejects.toThrow(/give the token/);
    await expect(svc.setCredentials('p', { auth: 'token', token: 'a b' })).rejects.toThrow(/spaces/);
  });

  it('token on an ssh URL is refused before anything is written', async () => {
    row('p', { repoUrl: 'git@github.com:o/r.git' });
    await expect(svc.setCredentials('p', { auth: 'token', token: TOKEN })).rejects.toThrow(/needs an https/);
    expect(svc.store.hasToken('p')).toBe(false);
  });

  it('ssh generate: returns the public key + fingerprint, never the private key; generate again replaces it', async () => {
    row('p', { repoUrl: 'git@gitlab.com:o/r.git' });
    const s1 = await svc.setCredentials('p', { auth: 'ssh', action: 'generate' });
    expect(s1.auth).toBe('ssh');
    expect(s1.sshPublicKey).toMatch(/^ssh-ed25519 AAAA\S+ aigentron:p@\S+$/);
    expect(s1.sshFingerprint).toMatch(/^SHA256:/);
    expect(s1.hostKeyTrusted).toBe(false);
    expect(s1.provider).toBe('gitlab');
    expect(JSON.stringify(s1)).not.toContain('PRIVATE KEY');
    expect(svc.store.modes('p')).toMatchObject({ id_ed25519: 0o600, 'id_ed25519.pub': 0o600 });
    const s2 = await svc.setCredentials('p', { auth: 'ssh' }); // no privateKey → generate
    expect(s2.sshFingerprint).not.toBe(s1.sshFingerprint);
  });

  it('ssh import: validates the key, refuses a passphrase-protected or public key', async () => {
    row('p', { repoUrl: 'git@github.com:o/r.git' });
    const other = new GitAccessService({ secretsDir: join(base, 'other'), agentRunAs: null } as AppConfigService, fakeProjects(), fakeSettings());
    rows.push({ ...rows[0]!, slug: 'src', id: 'id_src' });
    const made = await other.setCredentials('src', { auth: 'ssh', action: 'generate' });
    const privateKey = readFileSync(other.store.pathOf('src', 'privateKey'), 'utf8');
    const s = await svc.setCredentials('p', { auth: 'ssh', action: 'import', privateKey });
    expect(s.sshFingerprint).toBe(made.sshFingerprint);
    await expect(svc.setCredentials('p', { auth: 'ssh', action: 'import', privateKey: made.sshPublicKey! })).rejects.toThrow(/PUBLIC key/);
    await expect(svc.setCredentials('p', { auth: 'ssh', action: 'import', privateKey: 'nonsense' })).rejects.toThrow(GitAccessError);
    expect(s.sshFingerprint).toBe(made.sshFingerprint); // the failed imports did not touch the stored key
    expect((await svc.status('p')).sshFingerprint).toBe(made.sshFingerprint);
  });

  it('none: removes the token and the key, keeps the pinned hosts', async () => {
    row('p', { repoUrl: 'https://github.com/o/r.git' });
    await svc.setCredentials('p', { auth: 'token', token: TOKEN });
    svc.store.knownHostsPath('p');
    const s = await svc.setCredentials('p', { auth: 'none' });
    expect(s.auth).toBe('none');
    expect(s.tokenSet).toBe(false);
    expect(s.sshPublicKey).toBeNull();
    expect(svc.store.hasToken('p')).toBe(false);
    expect(existsSync(svc.store.pathOf('p', 'knownHosts'))).toBe(true);
  });

  it('setRepo patches url/branch/subdir through ProjectsService and forgets the last test; resetHostKey drops known_hosts', async () => {
    row('p', { repoUrl: 'https://github.com/o/r.git' });
    svc.store.writeLastTest('p', { at: 'x', ok: true, summary: 'ok', durationMs: 1 });
    const s = await svc.setRepo('p', { branch: 'dev', subdir: 'apps/web' });
    expect(s.branch).toBe('dev');
    expect(s.subdir).toBe('apps/web');
    expect(s.lastTest).toBeNull();
    writeFileSync(svc.store.knownHostsPath('p'), 'github.com ssh-ed25519 AAAA\n');
    await svc.setRepo('p', { url: 'git@github.com:o/r.git' });
    expect((await svc.status('p')).hostKeyTrusted).toBe(true);
    expect((await svc.resetHostKey('p')).hostKeyTrusted).toBe(false);
  });
});

describe('migrateLegacyToken', () => {
  it('moves AppSettings.githubToken of the default project to its file, clears the database, sets repoAuth; idempotent', async () => {
    const def = row('default', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'none' });
    settings.githubToken = TOKEN;
    expect(await svc.migrateLegacyToken()).toBe('migrated');
    expect(settings.githubToken).toBeNull();
    expect(def.repoAuth).toBe('token');
    expect(svc.store.readToken('default')).toBe(TOKEN);
    expect(svc.store.modes('default')).toMatchObject({ '.': 0o700, token: 0o600 });
    expect(await svc.migrateLegacyToken()).toBe('nothing');
    const st = await svc.status('default');
    expect(st.tokenSet).toBe(true);
    expect(st.tokenHint).toBe('…6789');
  });

  it('a token written to the database later (old settings endpoint) replaces the file and is cleared again', async () => {
    row('default', { repoUrl: 'https://github.com/o/r.git', repoAuth: 'ssh' });
    svc.store.writeToken('default', 'old_token_1111');
    settings.githubToken = 'new_token_2222';
    expect(await svc.migrateLegacyToken()).toBe('migrated');
    expect(svc.store.readToken('default')).toBe('new_token_2222');
    expect(settings.githubToken).toBeNull();
    expect(rows[0]!.repoAuth).toBe('ssh'); // an explicit non-"none" choice is kept
  });

  it('does nothing without a legacy token', async () => {
    row('default');
    expect(await svc.migrateLegacyToken()).toBe('nothing');
    expect(svc.store.hasToken('default')).toBe(false);
  });
});

describe('the connection test (real git, file:// remotes)', () => {
  const stepsById = (r: Awaited<ReturnType<GitAccessService['test']>>) => Object.fromEntries(r.steps.map((s) => [s.id, s]));

  it('passes for a reachable repository with the branch, reports the default branch, writes lastTest', async () => {
    const remote = makeRemote('ok');
    row('p', { repoUrl: `file://${remote}`, repoBranch: 'dev' });
    const r = await svc.test('p');
    const s = stepsById(r);
    expect(r.ok).toBe(true);
    expect(r.provider).toBe('generic');
    expect(r.defaultBranch).toBe('main');
    expect(s.url!.ok).toBe(true);
    expect(s.network!.ok).toBeNull(); // local path
    expect(s.auth!.ok).toBe(true);
    expect(s.branch!.ok).toBe(true);
    expect(s.branch!.detail).toContain('default branch "main"');
    expect(s.write!.ok).toBeNull();
    expect(s.size!.ok).toBeNull();
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    const last = (await svc.status('p')).lastTest!;
    expect(last.ok).toBe(true);
    expect(last.summary).toBe('ok (default branch main)');
  });

  it('a missing branch fails the branch step with the existing branches in the hint', async () => {
    row('p', { repoUrl: `file://${makeRemote('br')}`, repoBranch: 'release' });
    const r = await svc.test('p');
    const s = stepsById(r);
    expect(r.ok).toBe(false);
    expect(s.auth!.ok).toBe(true);
    expect(s.branch!.ok).toBe(false);
    expect(s.branch!.detail).toContain('"release" does not exist');
    expect(s.branch!.hint).toContain('dev, main');
    expect((await svc.status('p')).lastTest!.summary).toMatch(/^Branch: /);
  });

  it('an empty repository is fine (the first push creates the branch)', async () => {
    row('p', { repoUrl: `file://${makeRemote('empty', { empty: true })}` });
    const r = await svc.test('p');
    expect(r.ok).toBe(true);
    expect(stepsById(r).branch!.ok).toBeNull();
    expect(stepsById(r).branch!.detail).toContain('empty');
  });

  it('a repository that does not exist is classified as not found', async () => {
    row('p', { repoUrl: `file://${join(base, 'nope.git')}` });
    const r = await svc.test('p');
    const s = stepsById(r);
    expect(r.ok).toBe(false);
    expect(s.auth!.ok).toBe(false);
    expect(s.auth!.detail).toMatch(/does not exist/);
    expect(s.branch!.ok).toBeNull();
  });

  it('no URL / a URL that does not fit the access method fails at the url step', async () => {
    row('p');
    expect(stepsById(await svc.test('p')).url).toMatchObject({ ok: false, detail: expect.stringMatching(/no repository URL/) });
    row('q', { repoUrl: 'git@github.com:o/r.git', repoAuth: 'token' });
    const s = stepsById(await svc.test('q'));
    expect(s.url!.ok).toBe(false);
    expect(s.url!.detail).toMatch(/needs an https/);
    expect(s.auth!.ok).toBeNull();
  });

  it('ssh without a key stops at the auth step with the fix', async () => {
    row('p', { repoUrl: 'git@github.com:o/r.git', repoAuth: 'ssh' });
    const s = stepsById(await svc.test('p'));
    expect(s.url!.ok).toBe(true);
    expect(s.auth!.ok).toBe(false);
    expect(s.auth!.detail).toMatch(/has no key yet/);
    expect(s.network!.ok).toBeNull();
  });

  it('checkWrite: a dry-run push is accepted and leaves no ref on the remote', async () => {
    const remote = makeRemote('w');
    row('p', { repoUrl: `file://${remote}` });
    const r = await svc.test('p', { checkWrite: true });
    const s = stepsById(r);
    expect(r.ok).toBe(true);
    expect(s.write!.ok).toBe(true);
    expect(s.write!.detail).toMatch(/dry-run push was accepted/);
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/dev\nrefs/heads/main');
    expect((await svc.status('p')).lastTest!.summary).toBe('ok (default branch main), write access confirmed');
  });

  it('checkWrite: a dry run never reaches the remote hooks (a hook-refused push is only seen by a real push)', async () => {
    const remote = makeRemote('ro');
    writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "You are not allowed to push" >&2\nexit 1\n');
    chmodSync(join(remote, 'hooks', 'pre-receive'), 0o755);
    row('p', { repoUrl: `file://${remote}` });
    const r = await svc.test('p', { checkWrite: true });
    const s = stepsById(r);
    expect(s.auth!.ok).toBe(true);
    // a dry run stops before the hooks run → accepted; a hosting provider refuses at the receive-pack handshake instead
    expect(s.write!.ok).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('a token test over a real remote URL never leaks the token even when git fails', async () => {
    row('p', { repoUrl: 'https://127.0.0.1:1/o/r.git', repoAuth: 'token' });
    svc.store.writeToken('p', TOKEN);
    const r = await svc.test('p');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain(BASIC);
    const s = stepsById(r);
    expect(s.network!.ok === false || s.auth!.ok === false).toBe(true);
  });
});

describe('ssh plumbing end to end (a fake ssh on PATH records how git calls it)', () => {
  it('git runs OUR ssh command: -i <project key> and the project known_hosts', async () => {
    const bin = join(base, 'bin');
    mkdirSync(bin);
    const log = join(base, 'ssh.log');
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\necho "fake-ssh: Permission denied (publickey)." >&2\nexit 255\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    const p = row('p', { repoUrl: 'git@github.com:o/r.git', repoAuth: 'ssh' });
    await svc.setCredentials('p', { auth: 'ssh', action: 'generate' });
    const auth = await svc.authFor(p);
    const err = await runGit(['ls-remote', 'git@github.com:o/r.git', 'HEAD'], { auth, cwd: base, env: { PATH: `${bin}:${process.env.PATH}` }, timeoutMs: 20_000 }).catch((e: GitRunError) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(err.stderr).toContain('Permission denied (publickey)');
    const args = readFileSync(log, 'utf8').split('\n');
    expect(args).toContain('-i');
    expect(args[args.indexOf('-i') + 1]).toBe(svc.store.pathOf('p', 'privateKey'));
    expect(args).toContain(`UserKnownHostsFile=${svc.store.pathOf('p', 'knownHosts')}`);
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('git@github.com');
    expect(args.at(-2)).toBe("git-upload-pack 'o/r.git'");
  });
});
