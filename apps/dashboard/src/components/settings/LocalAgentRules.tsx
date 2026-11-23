import { useEffect, useState } from 'react';
import { api, type LocalAgentRules } from '@/lib/api';
import { Badge, Button, ErrorText, Muted, Row } from '@/components/ui';
import styles from './LocalAgentPanels.module.css';

type Loaded = Awaited<ReturnType<typeof api.localAgentRules>>;

const RULES: { key: 'snapshot' | 'fetch' | 'fastForward' | 'notify' | 'proposeCommit'; title: string; help: string }[] = [
  { key: 'snapshot', title: 'Snapshots', help: 'A safe copy of your uncommitted work (kept beside your branch, never touching it) while you are idle.' },
  { key: 'fetch', title: 'Fetch', help: 'git fetch on a timer: you see what is new on the remote. Never changes your files.' },
  { key: 'fastForward', title: 'Fast-forward', help: 'Moves the current branch forward when the remote only has new commits and your tree is clean (never merges, never touches local changes).' },
  { key: 'notify', title: 'Notify', help: 'Tells you when work stays uncommitted, or the branch stays behind, too long.' },
  { key: 'proposeCommit', title: 'Propose a commit', help: 'After a long idle period with changes, opens a task asking an agent to suggest a commit. It never commits by itself.' },
];

function Num({ value, min, max, onChange, suffix }: { value: number; min: number; max: number; onChange: (n: number) => void; suffix: string }) {
  return (
    <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <input type="number" min={min} max={max} value={value} style={{ width: 70 }} onChange={(e) => onChange(Number(e.target.value))} />
      <span>{suffix}</span>
    </label>
  );
}

/** The global rules, synced to every connected computer. A repository can tune them (and switch off) with `.aigentron/local.yaml`, but only switch ON what is allowed here. */
export function LocalAgentRulesEditor({ rulesRev, devices }: { rulesRev: number; devices: { online: boolean; rulesRev: number | null }[] }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<LocalAgentRules | null>(null);
  const [ignoreText, setIgnoreText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const apply = (l: Loaded) => {
    setLoaded(l);
    setDraft(structuredClone(l.rules));
    setIgnoreText(l.rules.ignore.join('\n'));
  };
  useEffect(() => void api.localAgentRules().then(apply).catch((e: Error) => setError(e.message)), []);
  if (!loaded || !draft) return error ? <ErrorText>{error}</ErrorText> : null;

  const dirty = JSON.stringify({ ...draft, ignore: ignoreText.split('\n').map((x) => x.trim()).filter(Boolean) }) !== JSON.stringify(loaded.rules);
  const online = devices.filter((d) => d.online);
  const upToDate = online.filter((d) => d.rulesRev === rulesRev).length;
  const set = <K extends keyof LocalAgentRules>(k: K, v: Partial<LocalAgentRules[K]>) => setDraft({ ...draft, [k]: { ...(draft[k] as object), ...(v as object) } } as LocalAgentRules);

  const save = () => {
    setSaving(true);
    setError(null);
    const next: LocalAgentRules = { ...draft, ignore: ignoreText.split('\n').map((x) => x.trim()).filter(Boolean) };
    void api
      .localAgentSaveRules(next)
      .then(() => api.localAgentRules())
      .then(apply)
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className={styles.section}>
      <strong className={styles.title}>Rules</strong>{' '}
      <Badge tone="neutral">revision {rulesRev || '—'}</Badge>{' '}
      {online.length > 0 && <Badge tone={upToDate === online.length ? 'done' : 'review'}>{upToDate === online.length ? 'applied on every online computer' : `applied on ${upToDate} of ${online.length} online`}</Badge>}
      <Muted className={styles.note}>
        What an agent may do on its own in a repository. Saved here, they reach your computers at once (and offline ones when they connect); a computer keeps a copy in <code>rules.global.yaml</code>. Hard limits — which folders, what needs your approval —
        are not settings and cannot be changed here or by a project.
      </Muted>
      <div style={{ display: 'grid', gap: 8, margin: '8px 0' }}>
        {RULES.map((r) => (
          <div key={r.key} style={{ borderLeft: '3px solid var(--border, #8884)', paddingLeft: 10 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={draft[r.key].enabled} onChange={(e) => set(r.key, { enabled: e.target.checked } as never)} />
              <strong>{r.title}</strong>
              {r.key === 'snapshot' && (
                <>
                  <Num value={draft.snapshot.idleMinutes} min={1} max={120} suffix="min idle" onChange={(n) => set('snapshot', { idleMinutes: n })} />
                  <Num value={draft.snapshot.keep} min={1} max={200} suffix="kept" onChange={(n) => set('snapshot', { keep: n })} />
                </>
              )}
              {r.key === 'fetch' && <Num value={draft.fetch.everyMinutes} min={1} max={1440} suffix="min between" onChange={(n) => set('fetch', { everyMinutes: n })} />}
              {r.key === 'notify' && (
                <>
                  <Num value={draft.notify.dirtyAfterMinutes} min={1} max={10080} suffix="min dirty" onChange={(n) => set('notify', { dirtyAfterMinutes: n })} />
                  <Num value={draft.notify.behindAfterMinutes} min={1} max={10080} suffix="min behind" onChange={(n) => set('notify', { behindAfterMinutes: n })} />
                </>
              )}
              {r.key === 'proposeCommit' && <Num value={draft.proposeCommit.idleMinutes} min={5} max={1440} suffix="min idle" onChange={(n) => set('proposeCommit', { idleMinutes: n })} />}
            </label>
            <Muted>{r.help}</Muted>
          </div>
        ))}
        <div style={{ borderLeft: '3px solid var(--border, #8884)', paddingLeft: 10 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong>Quiet while you type</strong>
            <Num value={draft.quiet.typingSeconds} min={5} max={600} suffix="s after your last edit" onChange={(n) => set('quiet', { typingSeconds: n })} />
          </label>
          <Muted>Nothing is done in a repository until this long after you last changed a file. A project can make it longer, never shorter.</Muted>
        </div>
        <div style={{ borderLeft: '3px solid var(--border, #8884)', paddingLeft: 10 }}>
          <strong>Also ignore</strong> <Muted>(one pattern per line, added to what git already ignores)</Muted>
          <textarea value={ignoreText} onChange={(e) => setIgnoreText(e.target.value)} rows={3} style={{ width: '100%', fontFamily: 'monospace' }} placeholder={'dist/**\n*.log'} />
        </div>
        <div style={{ borderLeft: '3px solid var(--amber, #c80)', paddingLeft: 10 }}>
          <strong>A repository may switch on:</strong>
          <Row wrap>
            {loaded.ruleNames.map((n) => (
              <label key={n} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={draft.projectCanEnable.includes(n)}
                  onChange={(e) => setDraft({ ...draft, projectCanEnable: e.target.checked ? [...draft.projectCanEnable, n] : draft.projectCanEnable.filter((x) => x !== n) })}
                />
                {n}
              </label>
            ))}
          </Row>
          <Muted>
            A project file comes from the repository, so anyone who can push to it can write it. By default it can only <em>switch rules off</em> and tune them; a rule above that is off here is switched on by a project only if you tick it.
          </Muted>
        </div>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
      <Row wrap>
        <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save and sync'}
        </Button>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setDraft(structuredClone(loaded.defaults));
            setIgnoreText(loaded.defaults.ignore.join('\n'));
          }}
        >
          Reset to defaults
        </Button>
        {dirty && <Muted>unsaved changes</Muted>}
      </Row>
      <details style={{ marginTop: 8 }}>
        <summary>Per project: <code>.aigentron/local.yaml</code></summary>
        <Muted>Put this file in a repository (commit it to share it with the team). Same keys as above, all optional; a typo is reported, not ignored. See what applies with <code>aigentron rules --repo .</code>.</Muted>
        <pre style={{ overflow: 'auto' }}>{`version: 1
snapshot:
  idleMinutes: 10        # tune
fetch:
  enabled: false         # a project may switch a rule off
ignore: ["build/**"]     # added to the global patterns
quiet:
  typingSeconds: 60      # longer is fine, shorter is ignored`}</pre>
      </details>
    </div>
  );
}
