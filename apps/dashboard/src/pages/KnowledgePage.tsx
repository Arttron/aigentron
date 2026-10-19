import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentInfo, type KbChunking, type KbDoc, type KbHit, type KbInfo, type ProviderInfo, type ResourceInfo } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { AppHeader, BackLink, Button, Card, CheckboxGroup, ErrorText, Field, Modal, Muted, Row, SectionTitle } from '@/components/ui';
import { ModelSelect } from '@/components/ModelSelect';
import { AddToSelect, ScopeBadge, ScopeBar, ScopeField } from '@/components/ScopeBar';
import { useScope } from '@/lib/use-scope';
import { filterByScope, scopeHelp, targetProject } from '@/lib/scope';
import styles from './KnowledgePage.module.css';

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const DEFAULT_CHUNKING: KbChunking = { strategy: 'section', maxChars: 3000, overlap: 200, minChars: 200 };

interface Draft {
  name: string;
  isNew: boolean;
  description: string;
  agents: string[];
  chunking: KbChunking;
  agentWrite: boolean;
  embedProvider: string;
  embedModel: string;
  /** The project's slug; null = global. */
  project: string | null;
}

const clean = (e: unknown) => (e as Error).message.replace(/^\d+ [^—]*— /, '');

/** A document row: stored ones are `ready`; one just added is `processing` (read / cut / stored in the background) until it is, or `error`. */
type Doc = KbDoc & { status?: 'processing' | 'ready' | 'error'; error?: string };
const STATUS_LABEL: Record<NonNullable<Doc['status']>, string> = { processing: '⏳ processing', ready: '✓ ready', error: '⚠ failed' };

/** Knowledge bases: big reference material agents search (BM25, plus meaning-based search when an embedding model is set). */
export function KnowledgePage() {
  const sc = useScope('knowledge');
  const [addTo, setAddTo] = useState('');
  const [allBases, setBases] = useState<KbInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [picked, setCurrent] = useState<string | null>(null);
  const bases = useMemo(() => filterByScope(allBases, sc.scope), [allBases, sc.scope]);
  // the picked base if the scope shows it, else the first one shown
  const current = bases.find((b) => b.name === picked)?.name ?? bases[0]?.name ?? null;
  const [docs, setDocs] = useState<Doc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [note, setNote] = useState<{ title: string; text: string } | null>(null);
  const [resources, setResources] = useState<ResourceInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ hits: KbHit[]; note?: string } | null>(null);
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.previewKb>> | null>(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [b, a, p] = await Promise.all([api.listKb(), api.listAgents(), api.listProviders()]);
      setBases(b);
      setAgents(a);
      setProviders(p);
    } catch (e) {
      setError(clean(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadDocs = useCallback(async (name: string | null) => {
    if (!name) return setDocs([]);
    setDocs(await api.listKbDocs(name).catch(() => []));
  }, []);
  useEffect(() => {
    setHits(null);
    void loadDocs(current);
  }, [current, loadDocs]);

  // vectors are made in the background, and so are documents just added (202 → processing): keep the counters and the rows moving until all is there
  const open = bases.find((b) => b.name === current) ?? null;
  const pending = open && open.embedProvider && open.embedded < open.chunks;
  const processing = docs.some((d) => d.status === 'processing');
  // only the counters and the document list move: re-read the bases and the docs, not the agents / providers as well
  usePolling(
    () => {
      void api.listKb().then(setBases).catch(() => undefined);
      if (processing) void loadDocs(current);
    },
    processing ? 2500 : 4000,
    Boolean(pending) || processing,
  );

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const msg = await fn();
      if (msg) setInfo(msg);
      await refresh();
      await loadDocs(current);
    } catch (e) {
      setError(clean(e));
    } finally {
      setBusy(false);
    }
  };

  // the server answers 202 at once: the document is read, cut and stored in the background and shows up below as "processing" until it is ready
  const added = (r: { chunks: number; duplicate: boolean; status?: string }, what: string) =>
    r.status === 'processing' ? `“${what}” is being added — it is processed in the background (see the list below).` : r.duplicate ? `“${what}” is already in the base.` : `Added “${what}” — ${r.chunks} passage(s).`;

  const upload = (files: FileList | File[]) =>
    run(async () => {
      const msgs: string[] = [];
      for (const f of Array.from(files)) {
        try {
          msgs.push(added(await api.uploadKbFile(current!, f), f.name));
        } catch (e) {
          msgs.push(`${f.name}: ${clean(e)}`);
        }
      }
      if (fileRef.current) fileRef.current.value = '';
      return msgs.join('  ');
    });

  const edit = (b?: KbInfo) =>
    setDraft(
      b
        ? { name: b.name, isNew: false, description: b.description, agents: b.agents, chunking: b.chunking, agentWrite: b.agentWrite, embedProvider: b.embedProvider ?? '', embedModel: b.embedModel ?? '', project: b.project ?? null }
        : { name: '', isNew: true, description: '', agents: [], chunking: DEFAULT_CHUNKING, agentWrite: false, embedProvider: '', embedModel: '', project: targetProject(sc.scope, addTo) },
    );

  const save = () =>
    run(async () => {
      if (!draft) return;
      const body = { description: draft.description, agents: draft.agents, chunking: draft.chunking, agentWrite: draft.agentWrite };
      if (draft.isNew) {
        const created = await api.createKb({ ...body, name: draft.name, ...(draft.project ? { project: draft.project } : {}), ...(draft.embedProvider ? { embedProvider: draft.embedProvider, embedModel: draft.embedModel || undefined } : {}) });
        setCurrent(created.name);
      } else {
        await api.updateKb(draft.name, { ...body, ...(draft.project !== (allBases.find((b) => b.name === draft.name)?.project ?? null) ? { project: draft.project } : {}), embedProvider: draft.embedProvider || null, embedModel: draft.embedProvider ? draft.embedModel || undefined : null });
      }
      setDraft(null);
    });

  // dry run of the chunking settings on a pasted sample
  const chunkingKey = draft ? JSON.stringify(draft.chunking) : '';
  useEffect(() => {
    if (!chunkingKey || !sample.trim()) return setPreview(null);
    let live = true; // a slow answer to an older keystroke must not replace a newer one
    const t = setTimeout(() => void api.previewKb(sample, JSON.parse(chunkingKey) as KbChunking).then((r) => live && setPreview(r)).catch(() => live && setPreview(null)), 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [chunkingKey, sample]);

  const embedders = providers.filter((p) => p.kind !== 'anthropic' && p.kind !== 'codex' && p.authMode !== 'oauth-token');
  const num = (v: string, d: number) => (v === '' ? d : Number(v));

  return (
    <>
      <BackLink href="/">← all tasks</BackLink>
      <AppHeader title="🧠 Knowledge" />
      <Card>
        <SectionTitle>Knowledge bases</SectionTitle>
        <Muted>
          Large reference material — regulations, manuals, textbooks, saved web pages — that agents <strong>search</strong> instead of carrying in the prompt. Documents are cut into passages; agents find them with
          keyword search (works offline, no key needed) and, if you give the base an embedding model, also by meaning. Short notes and photos that every agent should always see belong in{' '}
          <a href="/resources">Resources</a>. A <strong>global</strong> base is searched by every agent of every project; one scoped to a project only by agents working on it.
        </Muted>
        <Row wrap>
          <Button variant="primary" onClick={() => edit()}>
            + New base
          </Button>
          <AddToSelect state={sc} value={addTo} onChange={setAddTo} />
        </Row>
        <ScopeBar state={sc} />
        {bases.length > 0 && (
          <div className={styles.list}>
            {bases.map((b) => (
              <button key={b.id} type="button" className={b.name === current ? styles.baseOn : styles.base} onClick={() => setCurrent(b.name)}>
                <span className={styles.baseName}>{b.name}</span>
                <Muted>{b.description || 'no description'}</Muted>
                <span className={styles.facts}>
                  <span>
                    {b.docs} doc · {b.chunks} passages
                  </span>
                  <span>{b.embedProvider ? (b.embedded < b.chunks ? `🧠 semantic ${b.embedded}/${b.chunks}…` : '🧠 semantic on') : '🔤 keyword'}</span>
                  <span>{b.agents.length ? `for: ${b.agents.join(', ')}` : 'for all agents'}</span>
                  <ScopeBadge project={b.project} state={sc} />
                </span>
              </button>
            ))}
          </div>
        )}
        {bases.length === 0 && allBases.length > 0 && <Muted>No knowledge bases in this scope.</Muted>}
        {allBases.length === 0 && <Muted>No knowledge bases yet — create one, then upload documents (PDF, Word, Markdown, text, HTML, CSV).</Muted>}
        {error && <ErrorText>{error}</ErrorText>}
        {info && <Muted>{info}</Muted>}
      </Card>

      {open && (
        <Card>
          <Row spaceBetween>
            <SectionTitle>{open.name}</SectionTitle>
            <Row>
              <Button onClick={() => edit(open)}>Settings</Button>
              <Button
                variant="red"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Delete the knowledge base "${open.name}" with all its documents?`)) void run(async () => { await api.deleteKb(open.name); setCurrent(null); });
                }}
              >
                Delete
              </Button>
            </Row>
          </Row>
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
              <Button disabled={busy} onClick={() => setNote({ title: '', text: '' })}>
                📝 Add a note
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void api
                    .listResources()
                    .then((r) => setResources(r.items.filter((i) => i.kind === 'text' || i.kind === 'pdf' || /\.(md|txt|html?|csv|docx)$/i.test(i.originalName))))
                    .catch((e) => setError(clean(e)))
                }
              >
                📚 From Resources
              </Button>
              <Button disabled={busy} onClick={() => void run(async () => { const r = await api.importKbResearch(open.name); return `Saved web pages: ${r.added} added, ${r.skipped} skipped.`; })}>
                🌐 Saved web pages
              </Button>
              <Muted>or drop files here — PDF, Word (.docx), .md .txt .html .csv</Muted>
            </Row>
            <input ref={fileRef} type="file" multiple hidden accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm,.csv,.tsv,.json,.log,.rst,.yaml,.yml" onChange={(e) => e.target.files && void upload(e.target.files)} />
          </div>

          <form
            style={{ marginBottom: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (query.trim()) void api.searchKb(open.name, query).then(setHits).catch((er) => setError(clean(er)));
            }}
          >
            <Row wrap>
              <input style={{ flex: 1, minWidth: 220 }} placeholder="🔎 Try a search the way an agent would…" value={query} onChange={(e) => setQuery(e.target.value)} />
              <Button type="submit" disabled={!query.trim() || open.chunks === 0}>
                Search
              </Button>
            </Row>
          </form>
          {hits && (
            <>
              {hits.hits.length === 0 && <Muted>Nothing found.</Muted>}
              {hits.note && <Muted>{hits.note}</Muted>}
              {hits.hits.map((h, i) => (
                <div key={`${h.docId}-${h.chunk}`} className={styles.hit}>
                  <div className={styles.hitHead}>
                    {i + 1}. <strong>{h.docTitle}</strong>
                    {h.heading ? ` — ${h.heading}` : ''}
                    {h.source ? ` · ${h.source}` : ''}
                  </div>
                  <div className={styles.hitText}>{h.text}</div>
                </div>
              ))}
            </>
          )}

          <SectionTitle>Documents ({docs.length})</SectionTitle>
          {docs.length === 0 && <Muted>Empty — upload a document above.</Muted>}
          <ul className={styles.docs}>
            {docs.map((d) => {
              const status = d.status ?? 'ready';
              return (
                <li key={d.id} className={styles.doc}>
                  <div className={styles.docMain}>
                    <div className={styles.docTitle}>{d.title}</div>
                    <Muted>
                      {d.kind} · {status === 'ready' ? `${d.chunks} passages · ` : ''}
                      {kb(d.size)}
                      {d.source ? ` · ${d.source}` : ''}
                    </Muted>
                    {status === 'error' && (
                      <div className={styles.docError} role="alert">
                        {d.error ?? 'It could not be added.'}
                      </div>
                    )}
                  </div>
                  {/* the chip is always there (same width) so a row does not jump when its state changes */}
                  <span className={`${styles.status} ${status === 'processing' ? styles.statusProcessing : status === 'error' ? styles.statusError : styles.statusReady}`} aria-live={status === 'processing' ? 'polite' : undefined}>
                    {STATUS_LABEL[status]}
                  </span>
                  <Button
                    variant="red"
                    size="sm"
                    disabled={busy}
                    aria-label={status === 'error' ? `Dismiss ${d.title}` : `Remove ${d.title}`}
                    title={status === 'error' ? 'Dismiss' : 'Remove'}
                    onClick={() => {
                      if (status !== 'ready' || window.confirm(`Remove "${d.title}" from the base?`)) void run(() => api.deleteKbDoc(d.id).then(() => setHits(null)));
                    }}
                  >
                    ✕
                  </Button>
                </li>
              );
            })}
          </ul>
          {open.embedProvider && open.embedded < open.chunks && (
            <Row wrap>
              <Muted>
                Meaning-based search: {open.embedded} of {open.chunks} passages are ready ({open.embedProvider} · {open.embedModel}).
              </Muted>
              <Button size="sm" onClick={() => void api.reembedKb(open.name).then(refresh)}>
                Retry
              </Button>
            </Row>
          )}
        </Card>
      )}

      {note && open && (
        <Modal title={`Add a note to ${open.name}`} onClose={() => setNote(null)}>
          <Field label="Title">
            <input value={note.title} onChange={(e) => setNote({ ...note, title: e.target.value })} />
          </Field>
          <Field label="Text (Markdown)">
            <textarea rows={10} value={note.text} onChange={(e) => setNote({ ...note, text: e.target.value })} />
          </Field>
          <Row>
            <Button
              variant="primary"
              disabled={busy || !note.text.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await api.addKbNote(open.name, note);
                  setNote(null);
                  return added(r, note.title || 'note');
                })
              }
            >
              Add
            </Button>
            <Button onClick={() => setNote(null)}>Cancel</Button>
          </Row>
        </Modal>
      )}

      {resources && open && (
        <Modal title="Add from Resources" onClose={() => setResources(null)}>
          {resources.length === 0 && <Muted>No text documents in Resources.</Muted>}
          <ul className={styles.docs}>
            {resources.map((r) => (
              <li key={r.id} className={styles.doc}>
                <div className={styles.docMain}>
                  <div className={styles.docTitle}>{r.title}</div>
                  <Muted>{r.originalName}</Muted>
                </div>
                <Button size="sm" disabled={busy} onClick={() => void run(async () => added(await api.importKbResource(open.name, r.id), r.title))}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {draft && (
        <Modal title={draft.isNew ? 'New knowledge base' : `Settings: ${draft.name}`} onClose={() => setDraft(null)} wide>
          {draft.isNew && (
            <Field label="Name (letters, digits, - _) — agents are told it as is">
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="building-codes" />
            </Field>
          )}
          <Field label="What is in it — one line (agents read this to decide when to search it)">
            <textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
          {!draft.isNew && <ScopeField state={sc} value={draft.project} onChange={(project) => setDraft({ ...draft, project })} help={scopeHelp(draft.project, sc.projects)} />}
          <Field label="Which agents use it (none ticked = all)">
            <CheckboxGroup options={agents.map((a) => a.name)} selected={draft.agents} onChange={(sel) => setDraft({ ...draft, agents: sel })} empty="no agents yet" />
          </Field>
          <SectionTitle>How documents are cut into passages</SectionTitle>
          <div className={styles.grid2}>
            <Field label="Strategy">
              <select value={draft.chunking.strategy} onChange={(e) => setDraft({ ...draft, chunking: { ...draft.chunking, strategy: e.target.value as KbChunking['strategy'] } })}>
                <option value="section">By sections / clauses (regulations, manuals)</option>
                <option value="paragraph">By paragraphs (prose, articles)</option>
                <option value="chars">Fixed size (logs, OCR, unstructured)</option>
              </select>
            </Field>
            <Field label="Max size (characters)">
              <input type="number" min={300} max={12000} value={draft.chunking.maxChars} onChange={(e) => setDraft({ ...draft, chunking: { ...draft.chunking, maxChars: num(e.target.value, 3000) } })} />
            </Field>
            <Field label="Overlap">
              <input type="number" min={0} max={2000} value={draft.chunking.overlap} onChange={(e) => setDraft({ ...draft, chunking: { ...draft.chunking, overlap: num(e.target.value, 0) } })} />
            </Field>
            <Field label="Merge pieces shorter than">
              <input type="number" min={0} max={2000} value={draft.chunking.minChars} onChange={(e) => setDraft({ ...draft, chunking: { ...draft.chunking, minChars: num(e.target.value, 0) } })} />
            </Field>
          </div>
          <Field label="Try it: paste a sample text to see the passages">
            <textarea className={styles.sample} value={sample} onChange={(e) => setSample(e.target.value)} placeholder="# Chapter 1&#10;&#10;1. First clause…" />
          </Field>
          {preview && (
            <Muted>
              {preview.total} passage(s), about {preview.avg} characters each (largest {preview.max}).
              {preview.chunks.map((c, i) => (
                <span key={i} style={{ display: 'block', marginTop: 4 }}>
                  {i + 1}. {c.heading ? `[${c.heading}] ` : ''}
                  {c.text.replace(/\s+/g, ' ').slice(0, 110)}… ({c.chars})
                </span>
              ))}
              {draft.isNew ? '' : ' New settings apply to documents added from now on; to re-cut an existing one, remove and add it again.'}
            </Muted>
          )}
          <SectionTitle>Search by meaning (optional)</SectionTitle>
          <Muted>
            Keyword search always works. With an embedding model the base also finds passages by meaning (“floor base” ↔ “screed”) — it costs a few cents per million words and the text is sent to that
            provider. Switching the model re-indexes the base.
          </Muted>
          <div className={styles.grid2}>
            <Field label="Provider">
              <select value={draft.embedProvider} onChange={(e) => setDraft({ ...draft, embedProvider: e.target.value })}>
                <option value="">— keyword search only —</option>
                {embedders.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            {draft.embedProvider && (
              <Field label="Embedding model (empty = default)">
                <ModelSelect
                  provider={draft.embedProvider}
                  value={draft.embedModel}
                  onChange={(m) => setDraft({ ...draft, embedModel: m })}
                  suggestions={['text-embedding-3-small', 'text-embedding-3-large', 'nomic-embed-text', 'bge-m3']}
                  match={/embed|bge|minilm|e5|gte|nomic/i}
                  placeholder="— default for this provider —"
                />
              </Field>
            )}
          </div>
          <label style={{ display: 'block', margin: '10px 0' }}>
            <input type="checkbox" checked={draft.agentWrite} onChange={(e) => setDraft({ ...draft, agentWrite: e.target.checked })} /> Agents may add notes to this base themselves
          </label>
          {error && <ErrorText>{error}</ErrorText>}
          <Row>
            <Button variant="primary" disabled={busy || (draft.isNew && !draft.name.trim())} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button onClick={() => setDraft(null)}>Cancel</Button>
          </Row>
        </Modal>
      )}
    </>
  );
}
