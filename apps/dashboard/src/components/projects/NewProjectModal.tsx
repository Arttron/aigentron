import { useMemo, useState } from 'react';
import type { Project, ProjectIsolation, ProjectKind } from '@lds/shared';
import { api } from '@/lib/api';
import { ISOLATION_HELP, apiMessage, previewSlug, repoLine } from '@/lib/projects';
import { Button, ErrorText, Field, Modal, Muted } from '@/components/ui';
import styles from './projects.module.css';

/** Creates a project: name (→ slug preview), kind, and for code the repository, branch, subdirectory and mode. */
export function NewProjectModal({ existing, defaultIsolation, onClose, onCreated }: { existing: readonly Project[]; defaultIsolation: ProjectIsolation; onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('code');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [subdir, setSubdir] = useState('');
  const [mode, setMode] = useState<'' | ProjectIsolation>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = useMemo(() => previewSlug(name, existing.map((p) => p.slug)), [name, existing]);
  const effective = mode || defaultIsolation;
  const urlLine = repoLine(repoUrl);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const code = kind === 'code';
      const p = await api.createProject({
        name: name.trim(),
        kind,
        repoUrl: code && repoUrl.trim() ? repoUrl.trim() : undefined,
        repoBranch: code && branch.trim() ? branch.trim() : undefined,
        repoSubdir: code && subdir.trim() ? subdir.trim() : undefined,
        isolation: code && mode ? mode : undefined,
      });
      onCreated(p);
    } catch (err) {
      setError(apiMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New project" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Name">
          <input dir="auto" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Website, Кухня 2, Research notes" maxLength={80} />
        </Field>
        <Muted className={styles.note} style={{ minHeight: '1.4em' }}>
          Folder name (slug): <code>{slug}</code>
        </Muted>
        <Field label="Kind">
          <select className={styles.narrow} value={kind} onChange={(e) => setKind(e.target.value as ProjectKind)}>
            <option value="code">Code — a git repository, checks, branches</option>
            <option value="docs">Docs — drafts, notes and data, no git</option>
          </select>
        </Field>
        {kind === 'code' ? (
          <>
            <Field label="Repository URL (optional — leave blank for a local folder; access is set up on the project page)">
              <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/project.git" />
            </Field>
            {urlLine && <Muted className={styles.note}>{urlLine}</Muted>}
            <div className={styles.row2}>
              <Field label="Branch">
                <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
              </Field>
              <Field label="Subdirectory (optional)">
                <input value={subdir} onChange={(e) => setSubdir(e.target.value)} placeholder="(repo root)" />
              </Field>
            </div>
            <Field label="Mode">
              <select className={styles.narrow} value={mode} onChange={(e) => setMode(e.target.value as '' | ProjectIsolation)}>
                <option value="">Server default ({defaultIsolation})</option>
                <option value="shared">Shared</option>
                <option value="worktree">Worktree</option>
              </select>
            </Field>
            <Muted className={styles.note} style={{ minHeight: '3em' }}>
              {ISOLATION_HELP[effective]}
            </Muted>
          </>
        ) : (
          <Muted className={styles.note}>A docs project has a folder for its files and notes, but no repository, branches or checks.</Muted>
        )}
        <div className={styles.actions}>
          <Button variant="primary" type="submit" disabled={!name.trim() || busy}>
            {busy ? 'Creating…' : 'Create project'}
          </Button>
          <Button onClick={onClose}>Cancel</Button>
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      </form>
    </Modal>
  );
}
