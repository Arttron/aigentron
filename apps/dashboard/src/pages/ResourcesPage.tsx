import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentInfo, type ResourceInfo } from '@/lib/api';
import { AppHeader, BackLink, Button, Card, CheckboxGroup, ErrorText, Field, Modal, Muted, Row, SectionTitle } from '@/components/ui';
import styles from './ResourcesPage.module.css';

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const ICON: Record<ResourceInfo['kind'], string> = { text: '📝', image: '🖼', pdf: '📄', file: '📎' };

interface Draft {
  id: string | null;
  kind: ResourceInfo['kind'];
  title: string;
  description: string;
  tags: string;
  agents: string[];
  text: string;
}

/** The project's resource library: notes, images and documents every agent can use as knowledge. */
export function ResourcesPage() {
  const [items, setItems] = useState<ResourceInfo[]>([]);
  const [usage, setUsage] = useState<{ count: number; bytes: number; maxBytes: number } | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([api.listResources(), api.listAgents()]);
      setItems(r.items);
      setUsage(r.usage);
      setAgents(a);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tags = useMemo(() => Array.from(new Set(items.flatMap((i) => i.tags))).sort(), [items]);
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((i) => (!tag || i.tags.includes(tag)) && words.every((w) => `${i.title} ${i.description} ${i.tags.join(' ')} ${i.originalName}`.toLowerCase().includes(w)));
  }, [items, q, tag]);

  const fail = (e: unknown) => setError((e as Error).message.replace(/^\d+ [^—]*— /, ''));

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    setError(null);
    let last: ResourceInfo | null = null;
    try {
      for (const f of Array.from(files)) last = await api.uploadResource(f);
      await refresh();
      // One file: let the person add the description right away — agents decide what to read by it.
      if (last && Array.from(files).length === 1) await edit(last);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const edit = async (r: ResourceInfo) => {
    let text = '';
    if (r.kind === 'text') text = (await api.getResource(r.id).catch(() => null))?.text ?? '';
    setDraft({ id: r.id, kind: r.kind, title: r.title, description: r.description, tags: r.tags.join(', '), agents: r.agents, text });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const tagsArr = draft.tags.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
      if (draft.id) {
        await api.updateResource(draft.id, { title: draft.title, description: draft.description, tags: tagsArr, agents: draft.agents, ...(draft.kind === 'text' ? { text: draft.text } : {}) });
      } else {
        await api.createNote({ title: draft.title, description: draft.description, tags: tagsArr, agents: draft.agents, text: draft.text });
      }
      setDraft(null);
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="📚 Resources" />
      <Card>
        <SectionTitle>Project library</SectionTitle>
        <Muted>
          Notes, images and documents that <strong>every agent of this project</strong> can use as knowledge — house measurements, a style guide, a learner's
          profile, reference photos, a price list. Agents see the titles and descriptions and read what is relevant, so write a clear one-line description.
          {usage && ` ${usage.count} item(s), ${kb(usage.bytes)} of ${kb(usage.maxBytes)} used.`}
        </Muted>
        <div
          className={drag ? styles.dropOn : styles.drop}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
          }}
        >
          <Row wrap>
            <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              ⬆ Upload files
            </Button>
            <Button disabled={busy} onClick={() => setDraft({ id: null, kind: 'text', title: '', description: '', tags: '', agents: [], text: '' })}>
              📝 New note
            </Button>
            <Muted>or drop files here (up to 25 MB each — images, PDF, text, anything)</Muted>
          </Row>
          <input ref={fileRef} type="file" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} />
        </div>
        <Row wrap>
          <input className={styles.search} placeholder="🔎 Search the library…" value={q} onChange={(e) => setQ(e.target.value)} />
        </Row>
        {tags.length > 0 && (
          <div className={styles.tags} role="group" aria-label="Filter by tag">
            <button type="button" className={!tag ? styles.tagOn : styles.tag} onClick={() => setTag('')}>
              all
            </button>
            {tags.map((t) => (
              <button key={t} type="button" aria-pressed={tag === t} className={tag === t ? styles.tagOn : styles.tag} onClick={() => setTag(tag === t ? '' : t)}>
                {t}
              </button>
            ))}
          </div>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </Card>

      {shown.length === 0 && <Muted>{items.length ? 'Nothing matches.' : 'The library is empty. Upload a file or write a note.'}</Muted>}
      <div className={styles.grid}>
        {shown.map((r) => (
          <div key={r.id} className={styles.card}>
            <a className={styles.thumb} href={api.resourceUrl(r.id)} target="_blank" rel="noreferrer" title="Open">
              {r.kind === 'image' ? <img src={api.resourceUrl(r.id)} alt={r.title} loading="lazy" /> : <span aria-hidden>{ICON[r.kind]}</span>}
            </a>
            <div className={styles.body}>
              <strong className={styles.title}>{r.title}</strong>
              <div className={styles.desc}>{r.description || <em>no description — agents will not know when to use it</em>}</div>
              <div className={styles.facts}>
                <span>
                  {ICON[r.kind]} {r.kind} · {kb(r.size)}
                </span>
                <span>{r.agents.length ? `for: ${r.agents.join(', ')}` : 'for all agents'}</span>
                {r.tags.map((t) => (
                  <span key={t} className={styles.chip}>
                    {t}
                  </span>
                ))}
              </div>
              <div className={styles.buttons}>
                <Button onClick={() => void edit(r)}>Edit</Button>
                <Button
                  variant="red"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete "${r.title}" from the library?`)) void api.deleteResource(r.id).then(refresh).catch(fail);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <Modal title={draft.id ? `Edit: ${draft.title}` : 'New note'} onClose={() => setDraft(null)}>
          <Field label="Title">
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </Field>
          <Field label="Description — one line: what it is and when an agent should read it">
            <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          <Field label="Tags (comma-separated)">
            <input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="kitchen, measurements" />
          </Field>
          <Field label="Which agents use it (none ticked = all)">
            <CheckboxGroup options={agents.map((a) => a.name)} selected={draft.agents} onChange={(agentsSel) => setDraft({ ...draft, agents: agentsSel })} empty="no agents yet" />
          </Field>
          {draft.kind === 'text' && (
            <Field label="Text (Markdown)">
              <textarea rows={10} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
            </Field>
          )}
          {error && <ErrorText>{error}</ErrorText>}
          <Row>
            <Button variant="primary" disabled={busy || !draft.title.trim() || (draft.kind === 'text' && !draft.text.trim())} onClick={save}>
              Save
            </Button>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
          </Row>
        </Modal>
      )}
    </>
  );
}
