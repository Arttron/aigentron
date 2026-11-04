import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ChannelInfo, type Settings, type SettingsUpdate } from '@/lib/api';
import { Card, SectionTitle, Field, Row, Button, Muted, ErrorText } from '@/components/ui';
import { IntInput } from '@/components/IntInput';
import { resetAssistant } from '@/lib/float-position';
import { applyThemePref, getThemePref, type ThemePref } from '@/lib/theme';
import styles from './GeneralSettingsForm.module.css';

/** The cards of this form, and the settings each one edits (a form saves only the settings of the cards it shows). */
export type SettingsSection = 'repo' | 'escalations' | 'instructions' | 'verify' | 'queue' | 'approvals' | 'display';
const SECTION_FIELDS: Record<SettingsSection, readonly (keyof SettingsUpdate)[]> = {
  repo: ['repoUrl', 'repoBranch', 'workspaceSubdir', 'githubToken'],
  escalations: ['notifyChannelId', 'notifyChatId', 'approvalChatDelay', 'approvalChatNobodyAtOnce'],
  instructions: ['agentInstructions'],
  verify: ['verifyCommands', 'verifyMaxAttempts'],
  queue: ['concurrency', 'chatConcurrency', 'heavySlots', 'commandPipeline'],
  approvals: ['approvalTimeoutSeconds'],
  display: ['debugMode'],
};

/** The non-secret app settings, edited in one form with an explicit Save. `sections` picks the cards shown (default: all), in the order of the page. */
export function GeneralSettingsForm({ sections }: { sections?: readonly SettingsSection[] } = {}) {
  const show = (x: SettingsSection): boolean => !sections || sections.includes(x);
  const [s, setS] = useState<Settings | null>(null);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState<SettingsUpdate>({});
  const [githubToken, setGithubToken] = useState('');
  // Client-side only (per-browser, not part of SettingsUpdate/the server API) —
  // applies immediately on change, not gated behind "Save settings".
  const [themePref, setThemePref] = useState<ThemePref>('system');
  const [assistantReset, setAssistantReset] = useState(false);

  useEffect(() => {
    setThemePref(getThemePref());
  }, []);

  const changeTheme = (pref: ThemePref) => {
    applyThemePref(pref);
    setThemePref(pref);
  };

  useEffect(() => {
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
          concurrency: data.concurrency,
          chatConcurrency: data.chatConcurrency ?? 0,
          heavySlots: data.heavySlots ?? 0,
          approvalChatDelay: data.approvalChatDelay ?? 10,
          approvalChatNobodyAtOnce: data.approvalChatNobodyAtOnce ?? true,
          commandPipeline: data.commandPipeline ?? true,
          debugMode: data.debugMode,
          agentInstructions: data.agentInstructions,
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
      const mine = new Set<keyof SettingsUpdate>((Object.keys(SECTION_FIELDS) as SettingsSection[]).filter(show).flatMap((x) => SECTION_FIELDS[x]));
      const body: SettingsUpdate = Object.fromEntries(Object.entries(form).filter(([k]) => mine.has(k as keyof SettingsUpdate)));
      if (show('repo') && githubToken.trim()) body.githubToken = githubToken.trim();
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
      {show('repo') && (
        <Card>
          <SectionTitle>Repository (GitHub)</SectionTitle>
          <Muted className={styles.note}>
            These are the settings of the Default project — manage all projects on the <Link to="/projects">Projects page</Link>.
          </Muted>
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
            {/[:@\\]|^\/|\.\./.test(form.workspaceSubdir ?? '') && (
              <ErrorText>
                This looks like a URL or an absolute path, not a folder inside the repository. A git address belongs in
                “Repo URL”; here use a relative folder such as <code>apps/web</code>, or leave it empty for the repo root.
              </ErrorText>
            )}
          </Field>
          <Muted className={styles.note}>
            With a repo set, each task branches off the latest <code>{form.repoBranch || 'main'}</code>;
            on success the branch is pushed and a PR is opened. Agents run in the subdirectory above
            (blank = repo root); they can still read/write anywhere in the checkout.
          </Muted>
        </Card>
      )}

      {show('escalations') && (
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
          <Field label="Approvals and questions from the dashboard — when the chats hear about them">
            <select
              className={styles.narrow}
              value={(form.approvalChatDelay ?? 10) < 0 ? 'never' : (form.approvalChatDelay ?? 10) === 0 ? 'now' : 'wait'}
              onChange={(e) => set('approvalChatDelay', e.target.value === 'never' ? -1 : e.target.value === 'now' ? 0 : 10)}
            >
              <option value="wait">after a pause, if still open (the dashboard hears first)</option>
              <option value="now">at once, together with the dashboard</option>
              <option value="never">never (only the chat a task came from is asked)</option>
            </select>
          </Field>
          {(form.approvalChatDelay ?? 10) > 0 && (
            <>
              <Field label="Pause in seconds">
                <IntInput className={styles.narrow} min={1} max={3600} value={form.approvalChatDelay ?? 10} onCommit={(n) => set('approvalChatDelay', n)} />
              </Field>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <input type="checkbox" checked={form.approvalChatNobodyAtOnce ?? true} onChange={(e) => set('approvalChatNobodyAtOnce', e.target.checked)} style={{ width: 'auto', margin: 0 }} />
                When nobody is looking at the dashboard, send at once (no pause)
              </label>
            </>
          )}
          <Muted className={styles.note}>
            A request from a task started in the dashboard (an approval, a question, a task that needs input) appears there first; the chats above hear about it after the pause if nobody has
            answered. «Looking» means a dashboard window in front of someone — a tab in the background does not count, so turn the checkbox off to always keep the pause. A task started from a chat always
            asks in that chat, whatever is set here.
          </Muted>
          <Muted className={styles.note}>
            When an agent needs input on a task that has no channel of its own, its question is posted
            here. Reply in that chat to answer (routed back as a follow-up). Leave the channel blank to
            keep escalations dashboard-only. Subtask questions still go to the lead that created them.
          </Muted>
        </Card>
      )}

      {show('instructions') && (
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
      )}

      {show('verify') && (
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
            <IntInput
              className={styles.narrow}
              min={0}
              max={10}
              value={form.verifyMaxAttempts ?? 2}
              onCommit={(n) => set('verifyMaxAttempts', n)}
            />
          </Field>
          <Muted className={styles.note}>
            On failure the agent gets the output and retries; only a green run is marked done / pushed.
          </Muted>
        </Card>
      )}

      {show('queue') && (
        <Card>
          <SectionTitle>Task queue</SectionTitle>
          <Field label="Concurrency — agent runs processed in parallel">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={(form.concurrency ?? 1) === 0}
                onChange={(e) => set('concurrency', e.target.checked ? 0 : Math.max(1, s?.concurrencyEffective ?? 1))}
                style={{ width: 'auto', margin: 0 }}
              />{' '}
              Choose automatically for this machine{(form.concurrency ?? 1) === 0 && s?.concurrencyEffective ? ` (now ${s?.concurrencyEffective})` : ''}
            </label>
            <IntInput
              className={styles.narrow}
              min={1}
              max={20}
              disabled={(form.concurrency ?? 1) === 0}
              value={(form.concurrency ?? 1) === 0 ? (s?.concurrencyEffective ?? 1) : (form.concurrency ?? 1)}
              onCommit={(n) => set('concurrency', n)}
            />
          </Field>
          <Field label="Chat slots — chat turns and questions that run beside the tasks (they never wait behind long work)">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={(form.chatConcurrency ?? 0) === 0}
                onChange={(e) => set('chatConcurrency', e.target.checked ? 0 : Math.max(1, s?.chatConcurrencyEffective ?? 2))}
                style={{ width: 'auto', margin: 0 }}
              />{' '}
              Choose automatically for this machine{(form.chatConcurrency ?? 0) === 0 && s?.chatConcurrencyEffective ? ` (now ${s?.chatConcurrencyEffective})` : ''}
            </label>
            <IntInput
              className={styles.narrow}
              min={1}
              max={12}
              disabled={(form.chatConcurrency ?? 0) === 0}
              value={(form.chatConcurrency ?? 0) === 0 ? (s?.chatConcurrencyEffective ?? 2) : (form.chatConcurrency ?? 2)}
              onCommit={(n) => set('chatConcurrency', n)}
            />
          </Field>
          <Field label="Command pipeline — builds, tests and installs of all tasks wait in one queue">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <input type="checkbox" checked={form.commandPipeline ?? true} onChange={(e) => set('commandPipeline', e.target.checked)} style={{ width: 'auto', margin: 0 }} /> On
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <input
                type="checkbox"
                checked={(form.heavySlots ?? 0) === 0}
                disabled={!(form.commandPipeline ?? true)}
                onChange={(e) => set('heavySlots', e.target.checked ? 0 : Math.max(1, s?.heavySlotsEffective ?? 1))}
                style={{ width: 'auto', margin: 0 }}
              />{' '}
              Choose the number running at once automatically{(form.heavySlots ?? 0) === 0 && s?.heavySlotsEffective ? ` (now ${s?.heavySlotsEffective})` : ''}
            </label>
            <IntInput
              className={styles.narrow}
              min={1}
              max={8}
              disabled={!(form.commandPipeline ?? true) || (form.heavySlots ?? 0) === 0}
              value={(form.heavySlots ?? 0) === 0 ? (s?.heavySlotsEffective ?? 1) : (form.heavySlots ?? 1)}
              onCommit={(n) => set('heavySlots', n)}
            />
          </Field>
          <Muted className={styles.note}>
            Command pipeline: an agent runs a heavy command (install, build, tests, type check) through the server, which lets only this many run at once and starts each only while the machine is not busy; the agent just waits for the result.
            Light commands (git, ls, reading files) and servers that keep running are not affected. Automatic = 1 on a small machine, more with CPUs and memory.
          </Muted>
          <Muted className={styles.note}>
            Chat slots: a chat turn does not wait for the CPU, only for free memory. Automatic = about one per CPU, 2 to 6.
          </Muted>
          <Muted className={styles.note}>
            Takes effect live, within ~10s — no restart needed. In shared-workspace mode (one
            worktree for all tasks) this is effectively capped at 1 regardless of this value. Automatic = one less than the CPUs on a small server (2 vCPU → 1), memory permitting.
          </Muted>
        </Card>
      )}

      {show('approvals') && (
        <Card>
          <SectionTitle>Approval timeout</SectionTitle>
          <Field label="Approval timeout (seconds) — fail-closed deny after this">
            <IntInput
              className={styles.narrow}
              min={10}
              max={3600}
              value={form.approvalTimeoutSeconds ?? 300}
              onCommit={(n) => set('approvalTimeoutSeconds', n)}
            />
          </Field>
        </Card>
      )}

      {show('display') && (
        <Card>
          <SectionTitle>Display</SectionTitle>
          <Field label="Theme">
            <select
              className={styles.narrow}
              value={themePref}
              onChange={(e) => changeTheme(e.target.value as ThemePref)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </Field>
          <Muted className={styles.note}>
            Applies immediately — this is a per-browser preference, not part of "Save settings"
            below. "System" follows your OS's light/dark setting.
          </Muted>
          <Field label="Assistant">
            <Row>
              <Button
                onClick={() => {
                  resetAssistant();
                  setAssistantReset(true);
                  setTimeout(() => setAssistantReset(false), 2000);
                }}
              >
                Reset position / show
              </Button>
              {assistantReset && <Muted>done — the assistant is back in its corner</Muted>}
            </Row>
          </Field>
          <Muted className={styles.note}>
            The assistant bubble can be dragged anywhere and tucked away to a slim tab on the right edge. If it gets lost or
            hidden, this puts it back (per-browser, like the theme). Double-clicking the bubble does the same.
          </Muted>
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
      )}

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
