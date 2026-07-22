import { useEffect, useRef, useState } from 'react';
import { api, type AgentInfo } from '@/lib/api';
import { Card, SectionTitle, Row, Button, Muted, ErrorText } from '@/components/ui';
import { TaskReferencePicker } from './TaskReferencePicker';
import styles from './CreateTaskForm.module.css';

export function CreateTaskForm({ onCreated }: { onCreated?: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState('');
  const [defaultAgent, setDefaultAgent] = useState('');
  const [staged, setStaged] = useState<File[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const [showRefs, setShowRefs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch(() => undefined);
    api
      .getSettings()
      .then((s) => {
        setDefaultProvider(s.defaultProvider ?? '');
        setDefaultAgent(s.defaultAgent ?? '');
      })
      .catch(() => undefined);
  }, []);

  const canSubmit = !busy && (prompt.trim().length > 0 || staged.length > 0);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const text = prompt.trim() || 'Review the attached file(s).';
      // With attachments: create deferred, upload, then start — so the run never
      // reads the attachments dir before the files land.
      const task = await api.createTask({
        prompt: text,
        agentName: agentName || undefined,
        autostart: staged.length === 0,
        references: references.length ? references : undefined,
      });
      if (staged.length) {
        const names: string[] = [];
        for (const file of staged) names.push((await api.uploadAttachment(task.id, file)).name);
        await api.startTask(task.id, names);
      }
      setPrompt('');
      setAgentName('');
      setStaged([]);
      setReferences([]);
      onCreated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  // Single "Attach" menu → an image/file (opens the picker) or a task reference.
  const onAttachKind = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const kind = e.target.value;
    e.target.value = '';
    if (kind === 'file') fileRef.current?.click();
    else if (kind === 'task') setShowRefs(true);
  };

  const selected = agents.find((a) => a.name === agentName);

  return (
    <Card as="form" onSubmit={submit}>
      <SectionTitle>New task</SectionTitle>
      <textarea
        placeholder="Describe the task… (⌘/Ctrl+Enter to create) — attach references with 📎"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
      />

      {staged.length > 0 && (
        <Muted className={styles.staged}>
          {staged.map((f, i) => (
            <span key={`${f.name}-${i}`} className={styles.chip}>
              📎 {f.name}
              <button
                type="button"
                className={styles.chipRemove}
                onClick={() => setStaged((s) => s.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </span>
          ))}
        </Muted>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
        multiple
        className={styles.hidden}
        onChange={(e) => {
          if (e.target.files) setStaged((s) => [...s, ...Array.from(e.target.files!)]);
          if (fileRef.current) fileRef.current.value = '';
        }}
      />

      <Row wrap className={styles.controls}>
        {agents.length > 0 && (
          <select
            className={styles.agentSelect}
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            title={selected?.description}
          >
            <option value="">
              {defaultAgent
                ? `${defaultAgent} (default lead)`
                : defaultProvider
                  ? `${defaultProvider} (default)`
                  : 'default'}
            </option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.provider ? ` (${a.provider})` : ''}
              </option>
            ))}
          </select>
        )}
        <select className={styles.attachSelect} value="" onChange={onAttachKind} title="Attach">
          <option value="">📎 Attach…</option>
          <option value="file">🖼 Image / file</option>
          <option value="task">🔗 Task</option>
        </select>
        {(showRefs || references.length > 0) && (
          <TaskReferencePicker value={references} onChange={setReferences} />
        )}
        <Button variant="primary" type="submit" disabled={!canSubmit}>
          {busy ? 'Creating…' : 'Create task'}
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
      {selected?.description && <Muted className={styles.desc}>{selected.description}</Muted>}
    </Card>
  );
}
