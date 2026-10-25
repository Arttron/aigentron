/**
 * The pure half of the repository connection test and of token auth (repo-test-core.test.ts): the step shapes,
 * the error classification table (git/ssh stderr → a human message + a hint), the ls-remote parser and the
 * URL/auth compatibility rules. No I/O.
 */
import type { ParsedRepoUrl, ProjectRepoAuth, RepoProvider } from '../project-core';

export type RepoTestStepId = 'url' | 'network' | 'auth' | 'branch' | 'write' | 'size';

export interface RepoTestStep {
  id: RepoTestStepId;
  label: string;
  /** true = passed, false = failed, null = not checked (skipped or not applicable) */
  ok: boolean | null;
  detail: string;
  hint?: string;
}

export interface RepoTestReport {
  ok: boolean;
  provider: RepoProvider;
  steps: RepoTestStep[];
  defaultBranch?: string;
  durationMs: number;
}

export const STEP_LABELS: Record<RepoTestStepId, string> = {
  url: 'Repository URL',
  network: 'Network',
  auth: 'Access (authentication)',
  branch: 'Branch',
  write: 'Write access',
  size: 'Repository size',
};

export type FailureKind = 'bad-token' | 'key-rejected' | 'host-key-changed' | 'host-key-unknown' | 'not-found' | 'branch-missing' | 'dns' | 'timeout' | 'connection' | 'read-only' | 'no-git' | 'no-ssh' | 'unknown';

export interface Classified {
  kind: FailureKind;
  /** which step the failure belongs to */
  step: RepoTestStepId;
  message: string;
  hint?: string;
}

const PROVIDER_NAMES: Record<RepoProvider, string> = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', generic: 'the git host' };

function tokenHint(provider: RepoProvider): string {
  switch (provider) {
    case 'github':
      return 'Check the token on GitHub → Settings → Developer settings → Personal access tokens: it must not be expired and must have "Contents: read & write" (fine-grained) or the "repo" scope (classic) for this repository. Then save it again here.';
    case 'gitlab':
      return 'Check the token on GitLab → the project → Settings → Security → Access tokens (or your Personal access tokens): not expired, role Developer or above, scopes read_repository + write_repository. Then save it again here.';
    case 'bitbucket':
      return 'Bitbucket needs a repository access token or an app password with "Repositories: read / write". Then save it again here.';
    default:
      return 'Check that the token is valid, not expired and allows reading (and writing) this repository. Then save it again here.';
  }
}

function keyHint(provider: RepoProvider): string {
  switch (provider) {
    case 'github':
      return 'Add the public key shown above as a deploy key: GitHub → the repository → Settings → Deploy keys → Add deploy key (tick "Allow write access" if agents should push).';
    case 'gitlab':
      return 'Add the public key shown above as a deploy key: GitLab → the project → Settings → Repository → Deploy keys (tick "Grant write permissions" if agents should push).';
    case 'bitbucket':
      return 'Add the public key shown above as an access key: Bitbucket → the repository → Repository settings → Access keys. Access keys are read-only; for pushes add it to a user account instead (Personal settings → SSH keys).';
    default:
      return 'Add the public key shown above to the git server (authorized_keys / deploy keys) with read (and write) access to this repository.';
  }
}

/**
 * Classify git/ssh output (already redacted) into one failure. Order matters: the more specific patterns first.
 * `phase` says what we were doing (push errors on a known-good read mean "read-only").
 */
export function classifyGitFailure(text: string, ctx: { provider: RepoProvider; auth: ProjectRepoAuth; protocol: ParsedRepoUrl['protocol'] | null; phase: 'read' | 'write'; timedOut?: boolean }): Classified {
  const t = text ?? '';
  const who = PROVIDER_NAMES[ctx.provider];
  if (ctx.timedOut) return { kind: 'timeout', step: 'network', message: `${who} did not answer in time`, hint: 'Check the network / firewall / proxy of this server; a slow or blocked connection, or a VPN that is down, looks like this.' };
  if (/git is not installed/i.test(t)) return { kind: 'no-git', step: 'url', message: 'git is not installed on this server', hint: 'Install git (apt install git) and restart.' };
  // the ssh client itself is missing: do not blame the repository or the key (git then says "Could not read from remote repository")
  if (/ssh: (command )?not found|cannot run ssh|error: cannot run ssh|ssh: No such file or directory|execvp.*ssh/i.test(t))
    return { kind: 'no-ssh', step: 'network', message: 'the SSH client (openssh-client) is not installed on this server', hint: 'Install it (apt install openssh-client / dnf install openssh-clients) or update to an image that includes it, then test again. Until then use a token over https.' };
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key .* (does not match|has changed)|Offending (ECDSA |ED25519 |RSA )?key/i.test(t))
    return { kind: 'host-key-changed', step: 'auth', message: `the host key of ${who} does not match the one pinned for this project`, hint: 'If the server really changed its keys (a migration, a self-hosted host reinstalled), reset the pinned host key for this project and test again. If it did not, someone may be intercepting the connection — do not reset blindly.' };
  if (/No ED25519 host key is known|No (RSA|ECDSA) host key is known|are you sure you want to continue connecting/i.test(t))
    return { kind: 'host-key-unknown', step: 'auth', message: `the host key of ${who} is not pinned yet and could not be accepted`, hint: 'Reset the pinned host key for this project and test again (the first connection pins it).' };
  if (/Could not resolve host|Could not resolve hostname|Name or service not known|nodename nor servname|Temporary failure in name resolution|getaddrinfo/i.test(t))
    return { kind: 'dns', step: 'network', message: `the host name of ${who} cannot be resolved (DNS)`, hint: 'Check the URL for typos and the DNS / network of this server (is it offline? behind a proxy that is not configured for git?).' };
  if (/Connection timed out|Operation timed out|timed out after|Failed to connect .* Timed out|Connection timeout/i.test(t))
    return { kind: 'timeout', step: 'network', message: `the connection to ${who} timed out`, hint: 'A firewall or proxy is probably blocking the port (443 for https, 22 for ssh). Over ssh, GitHub also answers on port 443: ssh://git@ssh.github.com:443/owner/repo.git.' };
  if (/Connection refused|Network is unreachable|No route to host|Failed to connect to|Could not read from remote repository.*\n?.*(Connection|unreachable)|kex_exchange_identification|Connection closed by .* port 22|Connection reset by peer|ssh: connect to host/i.test(t))
    return { kind: 'connection', step: 'network', message: `no connection to ${who}`, hint: 'Check the network of this server (proxy, firewall, VPN). Over ssh the port is 22 unless the URL says otherwise.' };
  if (/marked as read only|read-only deploy key|deploy key.*read.?only|does not have write access|write access to repository not granted|You are not allowed to push|not authorized to push|insufficient permission|protected branch|403 Forbidden.*push|pre-receive hook declined|The requested URL returned error: 403/i.test(t) && ctx.phase === 'write')
    return { kind: 'read-only', step: 'write', message: 'reading works, but pushing is not allowed with these credentials', hint: ctx.auth === 'ssh' ? `The deploy key is read-only. ${keyHint(ctx.provider)}` : tokenHint(ctx.provider) };
  if (/Permission denied \(publickey|Permission denied \(publickey,|publickey\)\.?\s*$|no matching host key type|sign_and_send_pubkey|Load key .*: (invalid format|error in libcrypto|Permission denied)|too open|UNPROTECTED PRIVATE KEY FILE|no such identity/im.test(t))
    return { kind: 'key-rejected', step: 'auth', message: `${who} did not accept the SSH key`, hint: `${keyHint(ctx.provider)} If the key was added already, check that it is this project's key (fingerprint above) — ${who} refuses a deploy key that is registered on another repository.` };
  if (/Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Invalid username or (password|token)|401|Bad credentials|HTTP Basic: Access denied|Support for password authentication was removed|invalid credentials|not authorized|Access denied/i.test(t))
    return ctx.auth === 'none'
      ? { kind: 'bad-token', step: 'auth', message: `${who} asks for credentials — the repository is not public`, hint: 'Set access to "token" or "ssh" for this project (Project → Repository → Access) and test again.' }
      : { kind: 'bad-token', step: 'auth', message: `${who} rejected the token`, hint: tokenHint(ctx.provider) };
  if (/Remote branch .* not found|couldn't find remote ref|Could not find remote branch/i.test(t))
    return { kind: 'branch-missing', step: 'branch', message: 'the branch does not exist on the remote', hint: 'Check the branch name (the default branch is shown above) or create the branch in the repository.' };
  if (/Repository not found|repository .* not found|404|does not appear to be a git repository|not found|The project you were looking for could not be found|Project .* not found|fatal: '.*' does not exist|ERROR: .* denied|access denied or repository not exported/i.test(t))
    return {
      kind: 'not-found',
      step: 'auth',
      message: `${who} says the repository does not exist — or these credentials may not see it`,
      hint: ctx.auth === 'none' ? 'Check the URL (owner / name). A private repository looks "not found" without credentials: set access to "token" or "ssh".' : ctx.auth === 'ssh' ? `Check the URL (owner / name). ${keyHint(ctx.provider)}` : `Check the URL (owner / name) and that the token may access this repository. ${tokenHint(ctx.provider)}`,
    };
  if (/SSL certificate problem|certificate verify failed|unable to get local issuer certificate/i.test(t))
    return { kind: 'connection', step: 'network', message: `the TLS certificate of ${who} is not trusted by this server`, hint: 'A corporate proxy or a self-signed certificate on a self-hosted host: install its CA on this server (or set http.sslCAInfo for git).' };
  const first = t.trim().split('\n').filter((l) => l.trim() && !/^\s*(hint:|warning: )/i.test(l)).slice(-1)[0] ?? '';
  return { kind: 'unknown', step: ctx.phase === 'write' ? 'write' : 'auth', message: first ? `git failed: ${first.slice(0, 300)}` : 'git failed without a message', hint: 'Run the same operation by hand on this server to see the full output.' };
}

export interface LsRemoteInfo {
  /** the symbolic target of HEAD without `refs/heads/` (null when the remote is empty or hides it) */
  defaultBranch: string | null;
  branches: string[];
  /** `refs/heads/<x>` sha by branch */
  heads: Record<string, string>;
  empty: boolean;
}

/** Parse `git ls-remote --symref <url>` output. */
export function parseLsRemote(stdout: string): LsRemoteInfo {
  const heads: Record<string, string> = {};
  let defaultBranch: string | null = null;
  let any = false;
  for (const line of (stdout ?? '').split('\n')) {
    if (!line.trim()) continue;
    any = true;
    const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line);
    if (sym) {
      defaultBranch = sym[1]!;
      continue;
    }
    const m = /^([0-9a-f]{40,64})\s+refs\/heads\/(\S+)$/.exec(line);
    if (m) heads[m[2]!] = m[1]!;
  }
  return { defaultBranch, branches: Object.keys(heads).sort(), heads, empty: !any };
}

/**
 * Whether the URL and the auth mode go together. Returns the problem for the person, or null.
 * token → https only (the header scheme is http-only); ssh → ssh:// / scp-like only; none → anything.
 */
export function urlAuthProblem(parsed: ParsedRepoUrl | null, auth: ProjectRepoAuth): string | null {
  if (!parsed) return 'the repository URL is not set or not valid';
  if (auth === 'token' && parsed.protocol !== 'https' && parsed.protocol !== 'http') {
    const sshAdvice = `an ssh URL (use ssh access with a deploy key, or switch the URL to https://${parsed.host}/${parsed.owner ?? 'owner'}/${parsed.repo ?? 'repo'}.git)`;
    return `access by token needs an https:// URL — "${parsed.url}" is ${parsed.protocol === 'ssh' ? sshAdvice : `a ${parsed.protocol}:// URL`}`;
  }
  if (auth === 'ssh' && parsed.protocol !== 'ssh') return `access by SSH key needs an ssh URL (git@${parsed.host || 'host'}:${parsed.owner ?? 'owner'}/${parsed.repo ?? 'repo'}.git or ssh://git@${parsed.host || 'host'}/…) — "${parsed.url}" is ${parsed.protocol}`;
  if (auth === 'token' && parsed.protocol === 'http') return 'a token must not travel over plain http:// — use https://';
  return null;
}

/** The exact forms of a token that may appear in output: the raw value and the base64 Basic credential git sends. */
export function tokenForms(token: string): string[] {
  const forms = [token, Buffer.from(`x-access-token:${token}`).toString('base64')];
  return forms.filter((f) => f.length >= 4);
}

/** A redactor for a token (and its Basic form). Identity for an empty token. */
export function makeTokenRedactor(token: string | null | undefined): (text: string) => string {
  if (!token) return (t) => t;
  const forms = tokenForms(token);
  return (text: string) => {
    let out = text ?? '';
    for (const f of forms) out = out.split(f).join('***');
    return out;
  };
}

/** A short summary of a report for the stored "last test" line and the logs. */
export function summarizeReport(r: RepoTestReport): string {
  if (r.ok) {
    const write = r.steps.find((s) => s.id === 'write');
    return `ok${r.defaultBranch ? ` (default branch ${r.defaultBranch})` : ''}${write?.ok === true ? ', write access confirmed' : write?.ok === false ? ', read-only' : ''}`;
  }
  const failed = r.steps.find((s) => s.ok === false);
  return failed ? `${failed.label}: ${failed.detail}` : 'failed';
}
