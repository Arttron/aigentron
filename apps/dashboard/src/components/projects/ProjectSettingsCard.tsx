import { ApprovalModePicker } from '@/components/ApprovalModePicker';
import { useEffect, useState } from 'react';
import type { Project, ProjectIsolation } from '@lds/shared';
import { api, type AgentInfo, type ChannelInfo, type DeleteProjectOptions, type ProjectLibraryCounts } from '@/lib/api';
import { ISOLATION_HELP, apiMessage } from '@/lib/projects';
import { Button, Card, CheckboxGroup, ErrorText, Field, Modal, Muted, Row, SectionTitle } from '@/components/ui';
import styles from './projects.module.css';

/** Name, checks, default agent, notifications and mode; plus archive / delete. */
export function ProjectSettingsCard({ project, defaultIsolation, onSaved, onDeleted }: { project: Project & { counts?: ProjectLibraryCounts }; defaultIsolation: ProjectIsolation; onSaved: (p: Project) => void; onDeleted: () => void }) {
  const [name, setName] = useState(project.name);
  const [verify, setVerify] = useState(project.verifyCommands ?? '');
  const [attempts, setAttempts] = useState(project.verifyMaxAttempts);
  const [agent, setAgent] = useState(project.defaultAgent ?? '');
  const [pinned, setPinned] = useState<string[]>(project.pinnedAgents ?? []);
  const [channelId, setChannelId] = useState(project.notifyChannelId ?? '');
  const [chatId, setChatId] = useState(project.notifyChatId ?? '');
  const [mode, setMode] = useState<'' | ProjectIsolation>(project.isolation ?? '');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [dangerError, setDangerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ knowledge: boolean; resources: boolean } | null>(null);
  const code = project.kind === 'code';

  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => undefined);
    api.listChannels().then(setChannels).catch(() => undefined);
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setError(null);
    setSaved(false);
    try {
      const p = await api.updateProject(project.slug, {
        name: name.trim() || project.name,
        ...(code ? { verifyCommands: verify.trim() || null, verifyMaxAttempts: attempts, isolation: mode || null } : {}),
        defaultAgent: agent || null,
        pinnedAgents: pinned,
        notifyChannelId: channelId || null,
        notifyChatId: chatId.trim() || null,
      });
      onSaved(p);
      setSaved(true);
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const danger = async (what: 'archive' | 'delete', opts?: DeleteProjectOptions) => {
    const text =
      what === 'delete'
        ? ''
        : project.archivedAt
          ? `Restore the project “${project.name}”?`
          : `Archive the project “${project.name}”? It disappears from the lists and no new tasks can be started in it.`;
    if (what === 'archive' && !window.confirm(text)) return;
    setBusy(what);
    setDangerError(null);
    try {
      if (what === 'delete') {
        await api.deleteProject(project.slug, opts);
        setConfirmDelete(null);
        onDeleted();
      } else {
        onSaved(await api.updateProject(project.slug, { archived: !project.archivedAt }));
      }
    } catch (err) {
      setDangerError(apiMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <SectionTitle>Settings</SectionTitle>
      <form onSubmit={save}>
        <Field label="Name">
          <input dir="auto" className={styles.narrow} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Field>
        {code && (
          <>
            <Field label="Checks — commands (one per line) run after each task; blank = off">
              <textarea value={verify} onChange={(e) => setVerify(e.target.value)} rows={3} placeholder={'pnpm install\npnpm lint\npnpm test'} />
            </Field>
            <Field label="Max auto-fix attempts on failure (0 = fail without fixing)">
              <input className={styles.narrow} type="number" min={0} max={10} value={attempts} onChange={(e) => setAttempts(Number(e.target.value))} />
            </Field>
          </>
        )}
        <Field label="Default agent (leads tasks started in this project)">
          <select className={styles.narrow} value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">(server default)</option>
            {agent && !agents.some((a) => a.name === agent) && <option value={agent}>{agent}</option>}
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
                {a.provider ? ` (${a.provider})` : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Agents offered when creating a task here (none selected = every agent, as before)">
          <CheckboxGroup options={agents.map((a) => a.name)} selected={pinned} onChange={setPinned} empty="no agents yet" />
        </Field>
        <Field label="Approvals for this project's tasks (a task can override it; Inherit follows Settings → General → Approvals)">
          <ApprovalModePicker scope={{ project: project.slug }} compact />
        </Field>
        <Field label="Notification channel — where a question from a task of this project is posted">
          <select className={styles.narrow} value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">(none — the global escalation setting)</option>
            {channelId && !channels.some((c) => c.id === channelId) && <option value={channelId}>{channelId}</option>}
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Chat / thread id in that channel (e.g. your Telegram chat id)">
          <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="e.g. 123456789" />
        </Field>
        {code && (
          <>
            <Field label="Mode">
              <select className={styles.narrow} value={mode} onChange={(e) => setMode(e.target.value as '' | ProjectIsolation)}>
                <option value="">Server default ({defaultIsolation})</option>
                <option value="shared">Shared</option>
                <option value="worktree">Worktree</option>
              </select>
            </Field>
            <Muted className={styles.note} style={{ minHeight: '3em' }}>
              {ISOLATION_HELP[mode || defaultIsolation]}
            </Muted>
          </>
        )}
        <div className={styles.actions}>
          <Button variant="primary" type="submit" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save settings'}
          </Button>
          <span className={`${styles.status} ${styles.ok}`}>{saved ? 'Saved' : ''}</span>
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      </form>
      <hr className={styles.divider} />
      {project.isDefault ? (
        <Muted className={styles.note}>The default project cannot be archived or deleted.</Muted>
      ) : (
        <>
          <div className={styles.actions}>
            <Button disabled={busy !== null} onClick={() => void danger('archive')}>
              {project.archivedAt ? 'Restore' : 'Archive'}
            </Button>
            <Button variant="red" disabled={busy !== null} onClick={() => setConfirmDelete({ knowledge: false, resources: false })}>
              Delete project
            </Button>
          </div>
          <div className={styles.status} style={{ marginTop: 6 }}>
            {dangerError && <ErrorText>{dangerError}</ErrorText>}
          </div>
        </>
      )}
      {confirmDelete && (
        <Modal title={`Delete “${project.name}”?`} onClose={() => busy === null && setConfirmDelete(null)}>
          <Muted className={styles.note}>Its tasks and files are removed with it. This cannot be undone.</Muted>
          <label className={styles.check}>
            <input type="checkbox" checked={confirmDelete.knowledge} onChange={(e) => setConfirmDelete({ ...confirmDelete, knowledge: e.target.checked })} /> Also delete its knowledge bases
            {project.counts?.knowledge !== undefined && ` (${project.counts.knowledge})`}
          </label>
          <label className={styles.check}>
            <input type="checkbox" checked={confirmDelete.resources} onChange={(e) => setConfirmDelete({ ...confirmDelete, resources: e.target.checked })} /> Also delete its resource library
            {project.counts?.resources !== undefined && ` (${project.counts.resources})`}
          </label>
          <Muted className={styles.note} style={{ minHeight: '4.2em' }}>
            Left unticked, they are kept and become global — every agent of every project sees them. The project’s library folder is kept under the global library.
          </Muted>
          {dangerError && <ErrorText>{dangerError}</ErrorText>}
          <Row>
            <Button
              variant="red"
              disabled={busy !== null}
              onClick={() => void danger('delete', { knowledge: confirmDelete.knowledge ? 'delete' : 'keep', resources: confirmDelete.resources ? 'delete' : 'keep' })}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete project'}
            </Button>
            <Button disabled={busy !== null} onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
          </Row>
        </Modal>
      )}
    </Card>
  );
}
