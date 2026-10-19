import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ATTACH_ACCEPT, hasLiveCamera, prepareFile } from '@/lib/capture';
import { AttachMenu, type AttachKind } from '@/components/AttachMenu';
import { CameraCapture } from '@/components/CameraCapture';
import { uploadSizeError } from '@/lib/upload-limits';
import type { Project } from '@lds/shared';
import { api, type AgentInfo } from '@/lib/api';
import { pickProject, readProjectPref, writeProjectPref } from '@/lib/projects';
import { Card, SectionTitle, Row, Button, Muted, ErrorText, HiddenFileInput } from '@/components/ui';
import { DiscussionModal } from '@/components/DiscussionModal';
import { TaskReferencePicker } from './TaskReferencePicker';
import styles from './CreateTaskForm.module.css';

export function CreateTaskForm({ onCreated, projects = [] }: { onCreated?: () => void; projects?: Project[] }) {
  const [prompt, setPrompt] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState('');
  const [defaultAgent, setDefaultAgent] = useState('');
  const [staged, setStaged] = useState<File[]>([]);
  const [references, setReferences] = useState<string[]>([]);
  const [showRefs, setShowRefs] = useState(false);
  const [projectPick, setProjectPick] = useState<string>(() => readProjectPref() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  const navigate = useNavigate();
  const stage = async (files: File[]) => {
    // too big for the proxy → say so now, before a task is created without its file
    const tooBig = files.map(uploadSizeError).find(Boolean);
    if (tooBig) setError(tooBig);
    files = files.filter((f) => !uploadSizeError(f));
    const ready = await Promise.all(files.map(prepareFile));
    setStaged((s) => [...s, ...ready]);
  };

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
        project: projects.length > 1 ? project : undefined,
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
  const onAttachKind = (kind: AttachKind) => {
    if (kind === 'file') fileRef.current?.click();
    else if (kind === 'camera') {
      if (hasLiveCamera()) setCamera(true);
      else camRef.current?.click();
    } else if (kind === 'task') setShowRefs(true);
  };

  // only offered when there is a choice; the remembered one if it still exists, else the default project
  const project = pickProject(projects, projectPick);
  const selected = agents.find((a) => a.name === agentName);

  return (
    <Card as="form" onSubmit={submit}>
      <SectionTitle>New task</SectionTitle>
      <textarea dir="auto"
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

      <HiddenFileInput ref={fileRef} accept={ATTACH_ACCEPT} multiple onFiles={stage} />
      <HiddenFileInput ref={camRef} accept="image/*,video/*" capture onFiles={stage} />
      {camera && <CameraCapture onClose={() => setCamera(false)} onDone={(files) => void stage(files)} />}

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
        {projects.length > 1 && (
          <select
            className={styles.agentSelect}
            aria-label="Project"
            title="The project this task belongs to"
            value={project}
            onChange={(e) => {
              setProjectPick(e.target.value);
              writeProjectPref(e.target.value);
            }}
          >
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                📁 {p.name}
              </option>
            ))}
          </select>
        )}
        <AttachMenu onPick={onAttachKind} />
        {(showRefs || references.length > 0) && (
          <TaskReferencePicker value={references} onChange={setReferences} />
        )}
        <Button variant="primary" type="submit" disabled={!canSubmit}>
          {busy ? 'Creating…' : 'Create task'}
        </Button>
        <Button type="button" onClick={() => setDiscussing(true)} title="Several agents discuss a topic in a new chat">
          💬 Discuss
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
      {selected?.description && <Muted className={styles.desc}>{selected.description}</Muted>}
      {discussing && <DiscussionModal initialTopic={prompt} onClose={() => setDiscussing(false)} onStarted={(id) => navigate(`/tasks/${id}`)} />}
    </Card>
  );
}
