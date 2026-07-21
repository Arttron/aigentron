'use client';

import { useEffect, useState } from 'react';
import { api, type AgentInfo, type ChannelInfo, type Settings, type SettingsUpdate } from '@/lib/api';
import { Card, SectionTitle, Field, Row, Button, Muted, ErrorText } from '@/components/ui';
import styles from './GeneralSettingsForm.module.css';

/** The non-secret app settings, edited in one form with an explicit Save. */
export function GeneralSettingsForm() {
  const [s, setS] = useState<Settings | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState<SettingsUpdate>({});
  const [githubToken, setGithubToken] = useState('');

  useEffect(() => {
    api
      .listAgents()
      .then(setAgents)
      .catch(() => undefined);
    api
      .listChannels()
      .then(setChannels)
      .catch(() => undefined);
    api
      .getSettings()
      .then((data) => {
        setS(data);
        setForm({
          approvalTimeoutSeconds: data.approvalTimeoutSeconds,
          verifyCommands: data.verifyCommands,
          verifyMaxAttempts: data.verifyMaxAttempts,
          debugMode: data.debugMode,
          agentInstructions: data.agentInstructions,
          defaultAgent: data.defaultAgent ?? '',
          notifyChannelId: data.notifyChannelId ?? '',
          notifyChatId: data.notifyChatId ?? '',
          repoUrl: data.repoUrl ?? '',
          repoBranch: data.repoBranch,
          workspaceSubdir: data.workspaceSubdir ?? '',
        });
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const set = <K extends keyof SettingsUpdate>(k: K, v: SettingsUpdate[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: SettingsUpdate = { ...form };
      if (githubToken.trim()) body.githubToken = githubToken.trim();
      const updated = await api.updateSettings(body);
      setS(updated);
      setGithubToken('');
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (error && !s) return <ErrorText>{error}</ErrorText>;
  if (!s) return <Muted>Loading…</Muted>;

  return (
    <form onSubmit={save}>
      <Card>
        <SectionTitle>Repository (GitHub)</SectionTitle>
        <Field label="Repo URL (leave blank to work in a local workspace, no remote)">
          <input
            value={form.repoUrl ?? ''}
            onChange={(e) => set('repoUrl', e.target.value)}
            placeholder="https://github.com/org/project.git"
          />
        </Field>
        <Field label="Base branch">
          <input
            className={styles.narrow}
            value={form.repoBranch ?? ''}
            onChange={(e) => set('repoBranch', e.target.value)}
            placeholder="main"
          />
        </Field>
        <Field label="GitHub token (write access — used to clone, push branches, open PRs)">
          <input
            type="password"
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            placeholder={s.githubTokenSet ? `set (${s.githubTokenHint}) — leave blank to keep` : 'not set'}
          />
        </Field>
        <Field label="Project subdirectory (optional — a package within the repo, e.g. apps/web)">
          <input
            className={styles.narrow}
            value={form.workspaceSubdir ?? ''}
            onChange={(e) => set('workspaceSubdir', e.target.value)}
            placeholder="(repo root)"
          />
        </Field>
        <Muted className={styles.note}>
          With a repo set, each task branches off the latest <code>{form.repoBranch || 'main'}</code>;
          on success the branch is pushed and a PR is opened. Agents run in the subdirectory above
          (blank = repo root); they can still read/write anywhere in the checkout.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Default lead agent</SectionTitle>
        <Field label="Agent used as the lead for tasks that don't pick one (it delegates to the rest)">
          <select
            className={styles.narrow}
            value={form.defaultAgent ?? ''}
            onChange={(e) => set('defaultAgent', e.target.value)}
          >
            <option value="">(none — generic lead)</option>
            {agents.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Muted className={styles.note}>
          The lead orchestrates the run; e.g. <code>pm</code> plans and delegates to the team.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Escalations (questions from tasks with no channel)</SectionTitle>
        <Field label="Default channel — where a blocked/needs-input task created in the dashboard asks">
          <select
            className={styles.narrow}
            value={form.notifyChannelId ?? ''}
            onChange={(e) => set('notifyChannelId', e.target.value)}
          >
            <option value="">(none — dashboard only)</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Chat / thread id in that channel (e.g. your Telegram chat id)">
          <input
            value={form.notifyChatId ?? ''}
            onChange={(e) => set('notifyChatId', e.target.value)}
            placeholder="e.g. 123456789"
          />
        </Field>
        <Muted className={styles.note}>
          When an agent needs input on a task that has no channel of its own, its question is posted
          here. Reply in that chat to answer (routed back as a follow-up). Leave the channel blank to
          keep escalations dashboard-only. Subtask questions still go to the lead that created them.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Agent instructions (skill)</SectionTitle>
        <Field label="Appended to every agent's system prompt before it starts the task">
          <textarea
            value={form.agentInstructions ?? ''}
            onChange={(e) => set('agentInstructions', e.target.value)}
            rows={4}
            placeholder="e.g. Inspect the project before changing it; match existing style…"
          />
        </Field>
        <Muted className={styles.note}>
          Per-agent instructions live in <code>./agent/agents/*.md</code>; this is the default for
          tasks without an agent.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Verification gate</SectionTitle>
        <Field label="Commands (one per line) run in the worktree after each run; blank = off">
          <textarea
            value={form.verifyCommands ?? ''}
            onChange={(e) => set('verifyCommands', e.target.value)}
            rows={3}
            placeholder={'pnpm install\npnpm lint\npnpm test'}
          />
        </Field>
        <Field label="Max auto-fix attempts on failure (0 = fail without fixing)">
          <input
            className={styles.narrow}
            type="number"
            min={0}
            max={10}
            value={form.verifyMaxAttempts ?? 2}
            onChange={(e) => set('verifyMaxAttempts', Number(e.target.value))}
          />
        </Field>
        <Muted className={styles.note}>
          On failure the agent gets the output and retries; only a green run is marked done / pushed.
        </Muted>
      </Card>

      <Card>
        <SectionTitle>Approvals</SectionTitle>
        <Field label="Approval timeout (seconds) — fail-closed deny after this">
          <input
            className={styles.narrow}
            type="number"
            min={10}
            max={3600}
            value={form.approvalTimeoutSeconds ?? 300}
            onChange={(e) => set('approvalTimeoutSeconds', Number(e.target.value))}
          />
        </Field>
      </Card>

      <Card>
        <SectionTitle>Display</SectionTitle>
        <label className={styles.checkRow}>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={form.debugMode ?? false}
            onChange={(e) => set('debugMode', e.target.checked)}
          />
          <span>
            Debug mode — show verbose <code>assistant</code> lines in transcripts
          </span>
        </label>
      </Card>

      <Row>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
        {saved && <span className={styles.saved}>✓ saved</span>}
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
    </form>
  );
}
