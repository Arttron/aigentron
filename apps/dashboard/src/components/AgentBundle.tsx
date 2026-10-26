import { useEffect, useRef, useState } from 'react';
import { api, type AgentExportOptions, type AgentImportResult } from '@/lib/api';
import { Badge, Button, ErrorText, Modal, Muted, Row, type BadgeTone } from '@/components/ui';

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/** "Export": pick what travels with the agent (its custom + learned skills) and download one JSON file. */
export function ExportAgentModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [opts, setOpts] = useState<AgentExportOptions | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .agentExportOptions(name)
      .then((o) => {
        setOpts(o);
        setPicked(new Set([...o.custom, ...o.learned].filter((s) => s.listed).map((s) => s.name)));
      })
      .catch((e: Error) => setError(e.message));
  }, [name]);

  const toggle = (n: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (!next.delete(n)) next.add(n);
      return next;
    });

  const download = async () => {
    if (!opts) return;
    try {
      const bundle = await api.exportAgent(name, opts.learned.filter((s) => picked.has(s.name)).map((s) => s.name), opts.custom.filter((s) => picked.has(s.name)).map((s) => s.name));
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.agent.json`;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const group = (title: string, list: AgentExportOptions['learned']) =>
    list.length > 0 && (
      <div>
        <strong>{title}</strong>
        {list.map((s) => (
          <label key={s.name} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
            <input type="checkbox" checked={picked.has(s.name)} onChange={() => toggle(s.name)} />
            <span>{s.name}</span>
            <Muted>{kb(s.bytes)}</Muted>
            {s.listed && <Badge tone="neutral">used by the agent</Badge>}
          </label>
        ))}
      </div>
    );

  return (
    <Modal title={`Export agent: ${name}`} onClose={onClose}>
      <Muted>
        The file holds the agent&apos;s definition and the skills you tick. Learned skills are shared by every agent and may contain details of your projects or clients — tick only
        what should leave this server. Provider keys and secrets are never included.
      </Muted>
      {group('Custom skills', opts?.custom ?? [])}
      {group('Learned skills (experience)', opts?.learned ?? [])}
      {opts && !opts.custom.length && !opts.learned.length && <Muted>There are no custom or learned skills — only the agent file will be exported.</Muted>}
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        <Button variant="primary" onClick={() => void download()} disabled={!opts}>
          Download
        </Button>
        <Button onClick={onClose}>Cancel</Button>
      </Row>
    </Modal>
  );
}

/** "Import": choose a file → see what would be written → confirm; items that differ from the local ones are overwritten only when ticked. */
export function ImportAgentModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [bundle, setBundle] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [over, setOver] = useState<Set<string>>(new Set());
  const [res, setRes] = useState<AgentImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const plan = async (b: unknown, agentName: string, overwrite: Set<string>, dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importAgent(b, { agentName: agentName || undefined, overwrite: [...overwrite], dryRun });
      setRes(r);
      if (!dryRun) onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      const b = JSON.parse(await f.text()) as { agent?: { name?: string } };
      const n = b.agent?.name ?? '';
      setBundle(b);
      setName(n);
      setOver(new Set());
      await plan(b, n, new Set(), true);
    } catch {
      setError('This is not a valid agent file.');
    }
  };

  const toggle = (k: string) => {
    const next = new Set(over);
    if (!next.delete(k)) next.add(k);
    setOver(next);
    void plan(bundle, name, next, true);
  };

  const tone: Record<string, BadgeTone> = { new: 'done', same: 'neutral', different: 'review', blocked: 'failed' };

  return (
    <Modal title="Import agent" onClose={onClose}>
      <input ref={file} type="file" accept=".json,application/json" onChange={(e) => void pick(e.target.files?.[0])} />
      {bundle !== null && (
        <>
          <label>
            Agent name{' '}
            <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void plan(bundle, name, over, true)} />
          </label>
          {res?.plan.map((i) => (
            <div key={i.key} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge tone={tone[i.status]}>{i.status}</Badge>
              <span>
                {i.kind === 'agent' ? 'agent' : `${i.kind} skill`} <strong>{i.name}</strong>
              </span>
              {i.status === 'different' && !res.applied && (
                <label>
                  <input type="checkbox" checked={over.has(i.key)} onChange={() => toggle(i.key)} /> overwrite mine
                </label>
              )}
              {i.note && <Muted>{i.note}</Muted>}
            </div>
          ))}
          {res?.warnings.map((w) => (
            <Muted key={w}>⚠ {w}</Muted>
          ))}
        </>
      )}
      {error && <ErrorText>{error}</ErrorText>}
      <Row>
        {res && !res.applied && (
          <Button variant="primary" disabled={busy || !res.plan.some((i) => i.write)} onClick={() => void plan(bundle, name, over, false)}>
            Import
          </Button>
        )}
        <Button onClick={onClose}>{res?.applied ? 'Close' : 'Cancel'}</Button>
      </Row>
      {res?.applied && <Muted>Imported.</Muted>}
    </Modal>
  );
}
