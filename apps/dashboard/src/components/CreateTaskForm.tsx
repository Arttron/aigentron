import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ATTACH_ACCEPT, hasLiveCamera, prepareFile } from '@/lib/capture';
import { AttachMenu, type AttachKind } from '@/components/AttachMenu';
import { useSmartPaste } from '@/components/SmartPaste';
import { CameraCapture } from '@/components/CameraCapture';
import { uploadSizeError } from '@/lib/upload-limits';
import type { Project } from '@lds/shared';
import { api, errMsg, type AgentInfo } from '@/lib/api';
import { offeredAgents, pickProject, readProjectPref, writeProjectPref } from '@/lib/projects';
import { Card, SectionTitle, Row, Button, Muted, ErrorText, HiddenFileInput } from '@/components/ui';
import { DiscussionModal } from '@/components/DiscussionModal';
import { TaskReferencePicker } from './TaskReferencePicker';
import styles from './CreateTaskForm.module.css';

export function CreateTaskForm({ onCreated, projects = [], contextProject = '' }: { onCreated?: () => void; projects?: Project[]; /** the project the page is set to ('' = all): a new task goes there and the form does not ask */ contextProject?: string }) {
  const [prompt, setPrompt] = useState('');
  const { onPaste, notice: pasteNotice } = useSmartPaste(setPrompt);
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
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const stage = async (files: File[]) => {
    setError(null);
    setPreparing(true);
    try {
      // a photo is shrunk first, then judged by its size: a 12 MB phone photo is fine, a 30 MB PDF is not (the server takes 10 MB, a video 95 MB)
      const ready: File[] = [];
      const problems: string[] = [];
      for (const f of files) {
        try {
          const p = await prepareFile(f);
          const tooBig = uploadSizeError(p);
          if (tooBig) problems.push(tooBig);
          else ready.push(p);
        } catch (e) {
          problems.push(`“${f.name}” could not be read: ${(e as Error).message || 'the phone did not hand the file over'}. Pick it again.`);
        }
      }
      if (ready.length) setStaged((cur) => [...cur, ...ready]);
      if (problems.length) setError(problems.join('\n'));
    } finally {
      setPreparing(false);
    }
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

  const canSubmit = !busy && !preparing && (prompt.trim().length > 0 || staged.length > 0);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    let createdId: string | null = null;
    let phase: 'create' | 'upload' | 'start' = 'create';
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
      createdId = task.id;
      phase = 'upload';
      if (staged.length) {
        const names: string[] = [];
        for (const [i, file] of staged.entries()) {
          setProgress(`Uploading ${i + 1}/${staged.length}: ${file.name}`);
          try {
            names.push((await api.uploadAttachment(task.id, file)).name);
          } catch (err) {
            throw new Error(`“${file.name}” did not upload: ${errMsg(err)}`);
          }
        }
        setProgress('Starting…');
        phase = 'start';
        await api.startTask(task.id, names);
      }
      createdId = null;
      setPrompt('');
      setAgentName('');
      setStaged([]);
      setReferences([]);
      onCreated?.();
    } catch (err) {
      // a task that never got its files must not stay behind (and a retry must not make a second one): drop it, keep what the person typed and picked
      // Only a failure while the files were going up removes the task (nothing ran yet). Once the start was sent the answer may simply have been lost
      // (a proxy error after the server accepted it): deleting then would cancel a running task and a retry would run the work twice — say so and keep it.
      if (createdId && phase === 'upload') {
        await api.deleteTask(createdId).catch(() => undefined);
        setError(`${errMsg(err)} — nothing was created; your message and files are still here, try again.`);
      } else if (createdId && phase === 'start') {
        setError(`${errMsg(err)} — the task was created and its files uploaded, but the answer to the start was lost: look for it in the list below before sending it again.`);
        setPrompt('');
        setStaged([]);
        onCreated?.();
      } else setError(errMsg(err));
    } finally {
      setBusy(false);
      setProgress(null);
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
  const inContext = contextProject !== '' && projects.some((p) => p.slug === contextProject);
  const project = inContext ? contextProject : pickProject(projects, projectPick);
  // The agents pinned to the chosen project (none pinned = every agent); a pick that is no longer offered falls back to the default.
  const projectRow = projects.find((p) => p.slug === project);
  const offered = offeredAgents(agents, projectRow?.pinnedAgents);
  const selected = offered.find((a) => a.name === agentName);
  useEffect(() => {
    if (agentName && !offered.some((a) => a.name === agentName)) setAgentName('');
  }, [agentName, offered]);

  return (
    <Card as="form" onSubmit={submit}>
      <SectionTitle>New task</SectionTitle>
      <textarea dir="auto"
        placeholder="Describe the task… (⌘/Ctrl+Enter to create) — attach references with 📎"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
      />
      {pasteNotice}

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
            {offered.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.provider ? ` (${a.provider})` : ''}
              </option>
            ))}
          </select>
        )}
        {projects.length > 1 && !inContext && (
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
          {busy ? (progress ?? 'Creating…') : preparing ? 'Preparing files…' : 'Create task'}
        </Button>
        <Button type="button" onClick={() => setDiscussing(true)} title="Several agents discuss a topic in a new chat">
          💬 Discuss
        </Button>
      </Row>
      {error && <ErrorText style={{ whiteSpace: 'pre-line' }}>{error}</ErrorText>}
      {selected?.description && <Muted className={styles.desc}>{selected.description}</Muted>}
      {discussing && <DiscussionModal initialTopic={prompt} onClose={() => setDiscussing(false)} onStarted={(id) => navigate(`/tasks/${id}`)} />}
    </Card>
  );
}
