import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, errMsg, type WorkspaceEntry, type WorkspaceListing, type WorkspaceSummary } from '@/lib/api';
import { AppHeader, BackLink, Button, Card, ErrorText, Muted, Row, SectionTitle, UploadButton } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import styles from './WorkspacePage.module.css';

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase();
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const TEXT = new Set(['md', 'txt', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'toml', 'ini']);
const HINT: Record<string, string> = {
  memory: 'what the team knows: decisions, open questions, facts, plan, status (agents write it with workspace_note)',
  work: 'drafts, research notes and data — agents and you can add files here',
  deliverables: 'finished results for you (agents save them here; older versions are kept)',
};
const icon = (e: WorkspaceEntry) => (e.dir ? '📁' : IMAGE.has(ext(e.name)) ? '🖼' : ext(e.name) === 'pdf' ? '📄' : TEXT.has(ext(e.name)) ? '📝' : '📎');
const join = (a: string, b: string) => (a ? `${a}/${b}` : b);

/** The shared workspace as a person sees it: browse the folders, read results, upload into work/, edit the brief. */
export function WorkspacePage() {
  const [params, setParams] = useSearchParams();
  const dir = params.get('dir') ?? '';
  const file = params.get('file') ?? '';
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = (next: { dir?: string; file?: string }) => setParams({ ...(next.dir ? { dir: next.dir } : {}), ...(next.file ? { file: next.file } : {}) });
  const fail = (e: unknown) => setError(errMsg(e));

  const load = useCallback(async () => {
    try {
      setError(null);
      const [l, s] = await Promise.all([api.workspaceList(dir), api.workspaceSummary()]);
      setListing(l);
      setSummary(s);
    } catch (e) {
      fail(e);
    }
  }, [dir]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setEdit(null);
    setText(null);
    if (!file || !TEXT.has(ext(file))) return;
    let live = true;
    api
      .workspaceText(file)
      .then((t) => live && setText(t))
      .catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [file]);

  const upload = async (files: File[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const f of Array.from(files)) await api.workspaceUpload(join(dir, f.name), f);
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string) => {
    if (!window.confirm(`Delete ${path}? This cannot be undone.`)) return;
    try {
      await api.workspaceDelete(path);
      if (file === path) go({ dir });
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const saveBrief = async () => {
    if (edit === null) return;
    setBusy(true);
    try {
      await api.workspaceUpload('WORKSPACE.md', edit);
      setText(edit);
      setEdit(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const crumbs = dir ? dir.split('/') : [];
  const canDelete = (path: string) => path.startsWith('work/') || path.startsWith('deliverables/');
  const fileExt = ext(file);

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="📁 Workspace" />
      <Card>
        <SectionTitle>Shared workspace</SectionTitle>
        <Muted>
          One folder for the team's non-code work. <strong>WORKSPACE.md</strong> is the brief every agent reads (you edit it); <strong>memory/</strong> is what the team has decided
          and learned; <strong>work/</strong> holds drafts and data; <strong>deliverables/</strong> holds finished results for you.
          {summary && ` ${size(summary.bytes)} in total.`}
        </Muted>
        <nav className={styles.crumbs} aria-label="Folder">
          <button type="button" className={styles.crumb} onClick={() => go({})}>
            workspace
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {' / '}
              <button type="button" className={styles.crumb} onClick={() => go({ dir: crumbs.slice(0, i + 1).join('/') })}>
                {c}
              </button>
            </span>
          ))}
        </nav>
        <Muted className={styles.folderHint}>{HINT[dir.split('/')[0] ?? ''] ?? 'Open a folder, or the brief.'}</Muted>
        {error && <ErrorText>{error}</ErrorText>}
        <ul className={styles.list}>
          {/* the first row is always there (so nothing jumps): up one level, and the folder's actions */}
          <li className={`${styles.row} ${styles.first}`}>
            <button type="button" className={styles.name} disabled={!dir} onClick={() => go({ dir: crumbs.slice(0, -1).join('/') })} title={dir ? 'Up one level' : 'This is the top'}>
              <span aria-hidden>↩</span> ..
            </button>
            {listing?.writable && (
              <>
                <UploadButton className={styles.upload} disabled={busy} onFiles={upload} title="Upload files into this folder">
                  ⬆ Upload into this folder
                </UploadButton>
              </>
            )}
          </li>
          {listing?.entries.length === 0 && <li className={styles.empty}>Empty.</li>}
          {listing?.entries.map((e) => {
            const path = join(dir, e.name);
            return (
              <li key={e.name} className={`${styles.row} ${!e.dir && file === path ? styles.sel : ''}`}>
                <button type="button" className={styles.name} onClick={() => (e.dir ? go({ dir: path }) : go({ dir, file: path }))}>
                  <span aria-hidden>{icon(e)}</span> {e.name}
                </button>
                <span className={styles.meta}>
                  {e.dir ? '' : size(e.size)} {when(e.mtime)}
                </span>
                {!e.dir && (
                  <a className={styles.act} href={api.workspaceFileUrl(path, true)} title="Download">
                    ⬇
                  </a>
                )}
                {!e.dir && canDelete(path) && (
                  <button type="button" className={styles.act} title="Delete" onClick={() => void remove(path)}>
                    🗑
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {file && (
        <Card>
          <Row spaceBetween>
            <SectionTitle>{file}</SectionTitle>
            <Row wrap>
              {file === 'WORKSPACE.md' && edit === null && text !== null && <Button onClick={() => setEdit(text)}>✎ Edit brief</Button>}
              <a href={api.workspaceFileUrl(file, true)}>⬇ Download</a>
              <Button onClick={() => go({ dir })}>✕ Close</Button>
            </Row>
          </Row>
          {edit !== null ? (
            <>
              <textarea className={styles.editor} value={edit} onChange={(e) => setEdit(e.target.value)} rows={16} aria-label="Brief" />
              <Row wrap>
                <Button variant="primary" disabled={busy} onClick={() => void saveBrief()}>
                  Save
                </Button>
                <Button onClick={() => setEdit(null)}>Cancel</Button>
              </Row>
            </>
          ) : IMAGE.has(fileExt) ? (
            <img className={styles.img} src={api.workspaceFileUrl(file)} alt={file} />
          ) : fileExt === 'pdf' ? (
            <iframe className={styles.pdf} src={api.workspaceFileUrl(file)} title={file} />
          ) : TEXT.has(fileExt) ? (
            text === null ? (
              <Muted>Loading…</Muted>
            ) : fileExt === 'md' ? (
              <div className={styles.md}>
                <Markdown text={text} />
              </div>
            ) : (
              <pre className={styles.pre}>{text}</pre>
            )
          ) : (
            <Muted>No preview for this file type — download it.</Muted>
          )}
        </Card>
      )}
    </>
  );
}
