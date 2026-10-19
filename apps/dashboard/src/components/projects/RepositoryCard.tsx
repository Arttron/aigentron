import { useCallback, useEffect, useState } from 'react';
import type { Project, ProjectRepoAuth } from '@lds/shared';
import { api, type RepoInfo, type RepoTestResult } from '@/lib/api';
import { PROVIDER_NAME, apiMessage, checkRepoUrl, deployKeyPlace, providerTokenPage, relativeTime, repoLabel, stepMark, stepTone, testSummary } from '@/lib/projects';
import { Button, Card, ErrorText, Field, Muted, SectionTitle } from '@/components/ui';
import { CopyButton } from '@/components/CopyButton';
import styles from './projects.module.css';

/** What GET /repo would say, built from the project itself — used while the repo endpoint answers nothing. */
function fromProject(p: Project): RepoInfo {
  return {
    url: p.repo.url,
    branch: p.repo.branch,
    subdir: p.repo.subdir,
    provider: repoLabel(p.repo.url)?.provider ?? 'generic',
    auth: p.repo.auth,
    tokenSet: false,
    tokenHint: null,
    sshPublicKey: null,
    sshFingerprint: null,
    hostKeyTrusted: null,
    lastTest: null,
  };
}

const ACCESS: { id: ProjectRepoAuth; label: string }[] = [
  { id: 'none', label: 'Public' },
  { id: 'token', label: 'Token' },
  { id: 'ssh', label: 'SSH key' },
];

/** The checklist of a connection test: one line per check with ✓ / ✕ / –, its detail and (on a failure) a hint. */
export function TestChecklist({ result, at }: { result: RepoTestResult; at?: string }) {
  const steps = Array.isArray(result.steps) ? result.steps : [];
  return (
    <div data-testid="test-result">
      <ul className={styles.checks}>
        {steps.map((s) => (
          <li key={s.id} className={`${styles.check} ${styles[`tone_${stepTone(s)}`]}`}>
            <span className={styles.mark} aria-label={s.ok === true ? 'passed' : s.ok === false ? 'failed' : 'skipped'}>
              {stepMark(s)}
            </span>
            <span className={styles.checkBody}>
              {s.label}
              {s.detail && <span className={styles.checkDetail}>{s.detail}</span>}
              {s.ok === false && s.hint && <span className={styles.checkHint}>→ {s.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
      <p className={`${styles.summary} ${result.ok ? styles.ok : styles.fail}`}>
        {testSummary(result)}
        {at ? <Muted> · {relativeTime(at)}</Muted> : null}
      </p>
    </div>
  );
}

/** Repository: address / branch / folder, how it is reached (public, token, SSH key), a connection test and a sync. */
export function RepositoryCard({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const slug = project.slug;
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [subdir, setSubdir] = useState('');
  const [mode, setMode] = useState<ProjectRepoAuth>(project.repo.auth);
  const [token, setToken] = useState('');
  const [importing, setImporting] = useState(false);
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [checkWrite, setCheckWrite] = useState(false);
  const [test, setTest] = useState<(RepoTestResult & { at?: string }) | null>(null);
  const [sync, setSync] = useState<{ ok: boolean; message: string } | null>(null);

  const apply = useCallback((r: RepoInfo) => {
    setRepo(r);
    setUrl(r.url ?? '');
    setBranch(r.branch ?? 'main');
    setSubdir(r.subdir ?? '');
    setMode(r.auth);
  }, []);

  useEffect(() => {
    let live = true;
    api
      .getProjectRepo(slug)
      .then((r) => live && (apply(r), setLoadError(null)))
      .catch((e) => {
        if (!live) return;
        setLoadError(apiMessage(e));
        apply(fromProject(project));
      });
    return () => {
      live = false;
    };
  }, [slug, apply]);

  const run = async <T,>(what: string, fn: () => Promise<T>, done?: (r: T) => void) => {
    setBusy(what);
    setError(null);
    setSaved(null);
    try {
      done?.(await fn());
    } catch (e) {
      setError(apiMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!repo) {
    return (
      <Card>
        <SectionTitle>Repository</SectionTitle>
        <div className={styles.skeleton}>
          <Muted>Loading…</Muted>
        </div>
      </Card>
    );
  }

  if (project.kind === 'docs') {
    return (
      <Card>
        <SectionTitle>Repository</SectionTitle>
        <Muted className={styles.note}>A docs project keeps its files in its own folder and has no git repository.</Muted>
      </Card>
    );
  }

  const label = repoLabel(url);
  const provider = label?.provider ?? repo.provider;
  const tokenPage = providerTokenPage(provider, label?.host);
  const dirty = url.trim() !== (repo.url ?? '') || branch.trim() !== repo.branch || subdir.trim() !== (repo.subdir ?? '');
  const hint = repo.tokenHint ? (repo.tokenHint.startsWith('…') ? repo.tokenHint : `…${repo.tokenHint}`) : '';
  const hasUrl = !!(repo.url ?? '').trim();
  // The address is checked against the chosen access mode as it is typed (https + SSH key was the common mistake).
  const urlCheck = checkRepoUrl(url, mode);

  const saveRepo = () =>
    run(
      'save',
      () => api.setProjectRepo(slug, { url: url.trim() || null, branch: branch.trim() || undefined, subdir: subdir.trim() || null }),
      (r) => {
        apply(r);
        setTest(null);
        setSaved('Saved');
        onChanged();
      },
    );
  const setCreds = (what: string, body: Parameters<typeof api.setProjectRepoCredentials>[1], okText: string) =>
    run(what, () => api.setProjectRepoCredentials(slug, body), (r) => {
      apply(r);
      setToken('');
      setPrivateKey('');
      setImporting(false);
      setTest(null);
      setSaved(okText);
      onChanged();
    });
  const generate = () => {
    if (repo.sshPublicKey && !window.confirm('Replace the current key with a new one? The old public key stops working once you remove it from the repository.')) return;
    void setCreds('generate', { auth: 'ssh', action: 'generate' }, 'New key generated');
  };

  return (
    <Card>
      <SectionTitle>Repository</SectionTitle>
      {loadError && <Muted className={styles.note}>Access details could not be loaded ({loadError}); showing what the project says.</Muted>}
      <Field label={`Repository URL${label ? ` — ${PROVIDER_NAME[provider]}` : ''} (blank = a local folder, no remote)`}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/org/project.git  or  git@github.com:org/project.git" aria-invalid={urlCheck.level === 'error'} spellCheck={false} autoCapitalize="none" />
        {urlCheck.message && (
          <p className={`${styles.note} ${urlCheck.level === 'error' ? styles.fail : styles.warn}`} data-testid="url-check" role={urlCheck.level === 'error' ? 'alert' : undefined}>
            {urlCheck.message}{' '}
            {urlCheck.suggestion && (
              <Button onClick={() => setUrl(urlCheck.suggestion!)}>Use {urlCheck.suggestion}</Button>
            )}
          </p>
        )}
      </Field>
      <div className={styles.row2}>
        <Field label="Branch">
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
        </Field>
        <Field label="Subdirectory (optional, e.g. apps/web)">
          <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="(repo root)" />
        </Field>
      </div>
      <div className={styles.actions}>
        <Button variant="primary" disabled={!dirty || busy !== null || urlCheck.level === 'error'} onClick={() => void saveRepo()}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </Button>
        <span className={`${styles.status} ${styles.ok}`}>{saved}</span>
      </div>

      <hr className={styles.divider} />
      <Field label="Access">
        <span />
      </Field>
      <div className={styles.seg} role="group" aria-label="Access">
        {ACCESS.map((a) => (
          <button key={a.id} type="button" className={styles.segBtn} aria-pressed={mode === a.id} onClick={() => setMode(a.id)}>
            {a.label}
            {repo.auth === a.id ? ' ✓' : ''}
          </button>
        ))}
      </div>
      <div className={styles.panel}>
        {mode === 'none' && (
          <>
            <Muted className={styles.note}>A public repository needs no sign-in: agents can read it, but cannot push to it. For a private repository or to push, use a token or an SSH key.</Muted>
            {repo.auth !== 'none' && (
              <Button disabled={busy !== null} onClick={() => void setCreds('none', { auth: 'none' }, 'Saved: public access')}>
                Use without credentials
              </Button>
            )}
          </>
        )}
        {mode === 'token' && (
          <>
            <Field label="Access token">
              <input type="password" autoComplete="new-password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={repo.tokenSet ? `set (${hint || '…'}) — leave blank to keep` : 'not set'} />
            </Field>
            <Muted className={styles.note}>
              Needs read access to clone and write access to push branches and open pull requests. It is stored on the server and never shown again.
              {tokenPage && (
                <>
                  {' '}
                  Create one: <a href={tokenPage.href} target="_blank" rel="noreferrer">{tokenPage.label} ↗</a>
                </>
              )}
            </Muted>
            <Button variant="primary" disabled={!token.trim() || busy !== null} onClick={() => void setCreds('token', { auth: 'token', token: token.trim() }, 'Token saved')}>
              {busy === 'token' ? 'Saving…' : repo.tokenSet ? 'Replace token' : 'Save token'}
            </Button>
          </>
        )}
        {mode === 'ssh' && (
          <>
            {repo.sshPublicKey ? (
              <>
                <div className={styles.keyBox}>
                  <pre className={styles.keyText} data-testid="ssh-public-key">{repo.sshPublicKey}</pre>
                  <CopyButton text={repo.sshPublicKey} label="Copy public key" />
                </div>
                {repo.sshFingerprint && (
                  <Muted className={styles.note}>
                    Fingerprint: <span className={styles.mono}>{repo.sshFingerprint}</span>
                  </Muted>
                )}
                <ol className={styles.steps}>
                  <li>Copy the public key above.</li>
                  <li>
                    Add it as a deploy key (with write access if agents should push) in {deployKeyPlace(provider)}.
                  </li>
                  <li>Press “Test connection” below.</li>
                </ol>
                {repo.hostKeyTrusted === false && <Muted className={`${styles.note} ${styles.warn}`}>The server’s host key is not trusted yet; the first test will ask to trust it.</Muted>}
              </>
            ) : (
              <Muted className={styles.note}>An SSH key lets agents read and push without a token. Generate one here, then add its public half to the repository as a deploy key.</Muted>
            )}
            <div className={styles.actions}>
              <Button variant={repo.sshPublicKey ? undefined : 'primary'} disabled={busy !== null} onClick={generate}>
                {busy === 'generate' ? 'Generating…' : repo.sshPublicKey ? 'Generate a new key' : 'Generate key'}
              </Button>
              <Button size="sm" onClick={() => setImporting((v) => !v)}>
                {importing ? 'Cancel import' : 'Import existing key'}
              </Button>
            </div>
            {importing && (
              <div style={{ marginTop: 10 }}>
                <Field label="Private key (OpenSSH or PEM)">
                  <textarea rows={5} className={styles.mono} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…'} spellCheck={false} autoComplete="off" />
                </Field>
                <Muted className={`${styles.note} ${styles.warn}`}>The key must have no passphrase — agents cannot type one. Prefer a key made only for this repository.</Muted>
                <Button variant="primary" disabled={!privateKey.trim() || busy !== null} onClick={() => void setCreds('import', { auth: 'ssh', action: 'import', privateKey }, 'Key imported')}>
                  {busy === 'import' ? 'Importing…' : 'Import key'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <hr className={styles.divider} />
      <div className={styles.actions}>
        <Button
          variant="primary"
          disabled={!hasUrl || busy !== null || dirty}
          title={!hasUrl ? 'Set a repository URL first' : dirty ? 'Save the changes first' : undefined}
          onClick={() => void run('test', () => api.testProjectRepo(slug, checkWrite), (r) => setTest(r))}
        >
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </Button>
        <label className={styles.status} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={checkWrite} onChange={(e) => setCheckWrite(e.target.checked)} /> also check write access
        </label>
        <Button disabled={!hasUrl || busy !== null || dirty} onClick={() => void run('sync', () => api.syncProjectRepo(slug), (r) => setSync(r))}>
          {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </Button>
      </div>
      <div className={styles.status} style={{ marginTop: 6 }}>
        {sync && <span className={sync.ok ? styles.ok : styles.fail}>{sync.ok ? '✓ ' : '✕ '}{sync.message}</span>}
      </div>
      {test ? (
        <TestChecklist result={test} at={test.at} />
      ) : repo?.lastTest ? (
        // After a reload the server only keeps the verdict and one line; the full checklist comes back with the next test.
        <p className={`${styles.summary} ${repo.lastTest.ok ? styles.ok : styles.fail}`} data-testid="last-test">
          Last test: {repo.lastTest.ok ? '✓' : '✕'} {repo.lastTest.summary || (repo.lastTest.ok ? 'ok' : 'failed')}
          <Muted> · {relativeTime(repo.lastTest.at)}</Muted>
        </p>
      ) : (
        <Muted className={styles.note}>{hasUrl ? 'Not tested yet.' : 'No repository to test.'}</Muted>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Card>
  );
}
