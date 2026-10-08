import { useEffect, useRef, useState } from 'react';
import {
  CONTINUE_RUN_TOOL,
  PROPOSE_AGENT_TOOL,
  PROPOSE_AGENT_DELETE_TOOL,
  PROPOSE_BATCH_TOOL,
  PROPOSE_CLEANUP_TOOL,
  PROPOSE_PROVIDER_TOOL,
  PROPOSE_SCHEDULE_TOOL,
  PROPOSE_CHANNEL_TOOL,
  PROPOSE_RESOURCE_TOOL,
  PROPOSE_PACK_INSTALL_TOOL,
  describeSchedule,
  PROPOSE_SETTINGS_TOOL,
  PROPOSE_SKILL_TOOL,
  PROPOSE_TASK_ACTION_TOOL,
  PROPOSE_TASK_TOOL,
  PROPOSE_UNDO_TOOL,
  REQUEST_SECRET_TOOL,
  type ApprovalRequest,
} from '@lds/shared';
import { api, type PackInfo } from '@/lib/api';
import { Button, Row, Muted, ErrorText } from '@/components/ui';
import styles from './ApprovalCard.module.css';

/** Full content of an admin-agent proposal (agent/skill), plus the current agent prompt when it replaces one. */
function ProposalPreview({ approval }: { approval: ApprovalRequest }) {
  const input = (approval.toolInput ?? {}) as { name?: string; content?: string };
  const isAgent = approval.toolName === PROPOSE_AGENT_TOOL;
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isAgent || !input.name) return;
    let live = true;
    api
      .getAgent(input.name)
      .then((a) => live && setCurrent(a.instructions))
      .catch(() => live && setCurrent(null)); // not found → a brand-new agent
    return () => {
      live = false;
    };
  }, [isAgent, input.name]);
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        {isAgent ? 'Agent' : 'Skill'} <b>{input.name}</b>
        {isAgent && current === null && ' — new'}
        {isAgent && typeof current === 'string' && ' — replaces the existing agent'}
      </div>
      <pre className={styles.proposalBody}>{input.content}</pre>
      {typeof current === 'string' && (
        <details>
          <summary className={styles.optionsSummary}>Current prompt (will be replaced)</summary>
          <pre className={styles.proposalBody}>{current}</pre>
        </details>
      )}
    </div>
  );
}

/** Secure entry of an API key/token requested by the admin agent: the value is sent only to the server's secret endpoint. */
function SecretEntry({ approval, onDone, onError }: { approval: ApprovalRequest; onDone: () => void; onError: (m: string) => void }) {
  const i = (approval.toolInput ?? {}) as { target?: string; name?: string; reason?: string };
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const label = i.target === 'github_token' ? 'GitHub token' : i.target === 'channel' ? `bot token for the channel "${i.name}"` : `API key / token for provider "${i.name}"`;
  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await api.submitSecret(approval.id, value);
      setValue('');
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
      setValue('');
    }
  };
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>{label}</b>
      </div>
      {i.reason && <div className={styles.proposalHead}>{i.reason}</div>}
      <input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="paste it here — not in the chat"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
        }}
        style={{ width: '100%', margin: '6px 0' }}
      />
      <div className={styles.proposalHead}>Saved write-only on the server; the agent never sees it.</div>
      <Button variant="green" disabled={busy || !value.trim()} onClick={() => void save()}>
        Save key
      </Button>
    </div>
  );
}

const PREVIEW_TASKS = 12;

/** What an admin-agent platform action will touch: the task list (sampled) or the agent to delete. */
function PackPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as { name?: string; timezone?: string; reason?: string };
  const [pack, setPack] = useState<PackInfo | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getPack(i.name ?? '')
      .then((p) => live && setPack(p))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [i.name]);
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>
          Install the pack "{pack ? `${pack.icon ?? ''} ${pack.title}` : i.name}"
        </b>
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      <pre className={styles.proposalBody}>
        {pack
          ? [
              pack.description,
              '',
              `agents:     ${[...(pack.agents ?? []), ...(pack.catalogAgents ?? [])].join(', ') || '—'}`,
              `skills:     ${(pack.skills ?? []).join(', ') || '—'}`,
              `library:    ${(pack.resources ?? []).map((r) => r.title).join('; ') || '—'}`,
              `schedules:  ${(pack.schedules ?? []).map((s) => s.name).join('; ') || '—'}  (created SWITCHED OFF${i.timezone ? `, time zone ${i.timezone}` : ''})`,
              '',
              'Anything that already exists is left untouched.',
            ].join('\n')
          : 'Loading the pack contents…'}
      </pre>
    </div>
  );
}

function ResourcePreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as { action?: string; id?: string; title?: string; description?: string; tags?: string[]; agents?: string[]; text?: string; reason?: string };
  const verb = i.action === 'delete' ? 'Delete' : i.action === 'update' ? 'Change' : 'Add';
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>
          {verb} note {i.title ? `"${i.title}"` : `(${i.id})`} in the project library
        </b>
        {i.action !== 'delete' && ' — every agent will read it as project knowledge'}
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      {i.action !== 'delete' && (
        <pre className={styles.proposalBody}>
          {[
            i.description ? `about:  ${i.description}` : '',
            i.tags?.length ? `tags:   ${i.tags.join(', ')}` : '',
            i.agents?.length ? `for:    ${i.agents.join(', ')}` : 'for:    all agents',
            i.text ? `\n${i.text}` : '',
          ]
            .filter((l) => l !== '')
            .join('\n')}
        </pre>
      )}
    </div>
  );
}

function ChannelPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as {
    action?: string;
    name?: string;
    kind?: string;
    enabled?: boolean;
    defaultAgent?: string;
    allowChatId?: string;
    removeChatId?: string;
    reason?: string;
  };
  const verb = i.action === 'delete' ? 'Delete' : i.action === 'update' ? 'Change' : 'Create';
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>
          {verb} chat channel "{i.name}"
        </b>
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      {i.action !== 'delete' && (
        <pre className={styles.proposalBody}>
          {[
            i.kind ? `kind:      ${i.kind}` : '',
            i.action === 'create' ? 'starts:    switched OFF — turns on when the bot token is entered (next, in a secure field)' : '',
            i.enabled !== undefined ? `switch:    ${i.enabled ? 'ON' : 'OFF'}` : '',
            i.defaultAgent ? `agent:     tasks from this channel go to "${i.defaultAgent}"` : '',
            i.allowChatId ? `ALLOW chat ${i.allowChatId} — it will be able to create tasks and approve actions` : '',
            i.removeChatId ? `remove chat ${i.removeChatId} from the allowed chats` : '',
          ]
            .filter(Boolean)
            .join('\n')}
        </pre>
      )}
      {i.action === 'delete' && <div className={styles.proposalHead}>The bot stops listening; nothing else is deleted.</div>}
    </div>
  );
}

function SchedulePreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as {
    action?: string;
    name?: string;
    cron?: string;
    timezone?: string;
    kind?: string;
    text?: string;
    agentName?: string;
    channel?: string;
    chatId?: string;
    quietStart?: string;
    quietEnd?: string;
    enabled?: boolean;
    reason?: string;
  };
  const verb = i.action === 'delete' ? 'Delete' : i.action === 'update' ? 'Change' : 'Create';
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>
          {verb} schedule "{i.name}"
        </b>
        {i.action === 'delete' && ' — the job stops for good'}
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      {i.action !== 'delete' && (
        <pre className={styles.proposalBody}>
          {[
            i.cron ? `when:     ${describeSchedule(i.cron, i.timezone || 'UTC')}   [${i.cron}]` : '',
            i.kind === 'task' ? `does:     starts a TASK for agent "${i.agentName}" each time (uses model budget)` : '',
            i.kind === 'message' ? 'does:     posts a message (no model, free)' : '',
            i.channel ? `where:    ${i.channel}${i.chatId ? `, chat ${i.chatId}` : ''}` : '',
            i.quietStart ? `quiet:    ${i.quietStart}–${i.quietEnd} (runs inside are skipped)` : '',
            i.enabled === false ? 'enabled:  no (created switched off)' : '',
            i.text ? `${i.kind === 'task' ? 'prompt' : 'message'}:\n${i.text}` : '',
          ]
            .filter(Boolean)
            .join('\n')}
        </pre>
      )}
    </div>
  );
}

function ProviderPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as {
    name?: string;
    kind?: string;
    model?: string;
    authMode?: string;
    baseUrl?: string;
    makeDefault?: boolean;
    reason?: string;
  };
  const [existing, setExisting] = useState<'unknown' | 'new' | 'update'>('unknown');
  useEffect(() => {
    let live = true;
    api
      .listProviders()
      .then((ps) => live && setExisting(ps.some((p) => p.name === i.name) ? 'update' : 'new'))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [i.name]);
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        {existing === 'update' ? 'Update provider' : existing === 'new' ? 'Create provider' : 'Provider'} <b>{i.name}</b>
        {i.makeDefault && ' — and make it the DEFAULT provider'}
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      <pre className={styles.proposalBody}>
        {[
          `kind:      ${i.kind}`,
          `model:     ${i.model}`,
          `auth mode: ${i.authMode}`,
          `base URL:  ${i.baseUrl || '(family default)'}`,
          'secret:    not part of this request — a stored key is left untouched;',
          '           paste/replace keys yourself in Settings → Providers → Edit',
        ].join('\n')}
      </pre>
    </div>
  );
}

function CleanupPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as { runs?: boolean; worktrees?: boolean; deleteBranches?: boolean; olderThanDays?: number; reason?: string };
  const [dry, setDry] = useState<{ runsRemoved: number; runBytes: number; worktreesRemoved: number; branchesDeleted: number } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api
      .maintenanceDryRun({ runs: i.runs !== false, worktrees: i.worktrees === true, deleteBranches: i.deleteBranches === true, olderThanDays: i.olderThanDays })
      .then((r) => live && setDry(r))
      .catch(() => live && setDry(null));
    return () => {
      live = false;
    };
  }, [i.runs, i.worktrees, i.deleteBranches, i.olderThanDays]);
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>Clean up old leftovers</b>
        {i.olderThanDays ? ` older than ${i.olderThanDays} day(s)` : ' (default retention)'}
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      <pre className={styles.proposalBody}>
        {[
          i.runs !== false ? `run folders:   ${dry ? `${dry.runsRemoved} (${mb(dry.runBytes)})` : dry === null ? 'n/a' : '…'}` : 'run folders:   not included',
          i.worktrees ? `git worktrees: ${dry ? dry.worktreesRemoved : dry === null ? 'n/a' : '…'}  (working copies of old tasks; commits stay in their branches)` : 'git worktrees: not included',
          i.deleteBranches
            ? `branches:      ${dry ? dry.branchesDeleted : dry === null ? 'n/a' : '…'}  — DELETES agent/task-* branches; commits never pushed are LOST`
            : 'branches:      kept',
          'live tasks are never touched',
        ].join('\n')}
      </pre>
    </div>
  );
}

function SettingsPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as { changes?: Record<string, unknown>; reason?: string };
  const [cur, setCur] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getSettings()
      .then((s) => live && setCur(s as unknown as Record<string, unknown>))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  // The NEW value is shown in full — the approver must see everything they are approving (e.g. shell verify commands).
  const show = (v: unknown, clip = false) =>
    v === null || v === undefined || v === '' ? '(empty)' : clip && typeof v === 'string' && v.length > 600 ? `${v.slice(0, 600)}…` : String(v);
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>Change platform settings</b>
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      <pre className={styles.proposalBody}>
        {Object.entries(i.changes ?? {})
          .map(([k, v]) => `${k}\n   now:  ${cur ? show(cur[k], true) : '…'}\n   new:  ${show(v)}`)
          .join('\n\n')}
      </pre>
      <div className={styles.proposalHead}>The previous values are journaled, so this can be reverted from the admin chat.</div>
    </div>
  );
}

type BatchItem = { kind: string; args: Record<string, unknown> };

function batchItemTitle(it: BatchItem): string {
  const a = it.args;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (it.kind) {
    case 'agent':
      return `Agent "${str(a.name)}" — create or replace`;
    case 'skill':
      return `Skill "${str(a.name)}" — create or replace`;
    case 'agent_delete':
      return `Delete agent "${str(a.name)}"`;
    case 'provider':
      return `Provider "${str(a.name)}" (${str(a.kind)}, ${str(a.model)}, ${str(a.authMode)})${a.makeDefault ? ' — make DEFAULT' : ''}`;
    case 'settings':
      return `Settings: ${Object.keys((a.changes ?? {}) as object).join(', ')}`;
    case 'task':
      return `Start a task for agent "${str(a.agentName)}"${a.title ? ` — ${str(a.title)}` : ''}`;
    case 'task_action':
      return `${str(a.action) === 'delete' ? 'DELETE' : 'Cancel'} ${Array.isArray(a.taskIds) ? a.taskIds.length : 0} task(s)`;
    default:
      return it.kind;
  }
}

function batchItemDetail(it: BatchItem): string {
  const a = it.args;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  if (it.kind === 'agent' || it.kind === 'skill') return str(a.content);
  if (it.kind === 'task') return str(a.prompt);
  if (it.kind === 'settings') return JSON.stringify(a.changes, null, 2);
  if (it.kind === 'task_action') return (Array.isArray(a.taskIds) ? a.taskIds : []).join('\n');
  return JSON.stringify(a, null, 2);
}

function BatchPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as { items?: BatchItem[]; reason?: string };
  const items = Array.isArray(i.items) ? i.items : [];
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>{items.length} changes in one approval</b>, applied in this order
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      {items.map((it, n) => (
        <details key={n} open={items.length <= 3 || ['settings', 'agent', 'skill', 'task', 'provider'].includes(it.kind)}>
          <summary className={styles.optionsSummary}>
            {n + 1}. {batchItemTitle(it)}
          </summary>
          <pre className={styles.proposalBody}>{batchItemDetail(it)}</pre>
        </details>
      ))}
      <div className={styles.proposalHead}>Each change is journaled separately and can be reverted from the admin chat. If one fails, the rest are skipped.</div>
    </div>
  );
}

function TaskStartPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as { agentName?: string; prompt?: string; title?: string; reason?: string };
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        Start a task for agent <b>{i.agentName}</b>
        {i.title ? ` — “${i.title}”` : ''}
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      <pre className={styles.proposalBody}>{i.prompt}</pre>
      <div className={styles.proposalHead}>It starts immediately and uses that agent&rsquo;s provider.</div>
    </div>
  );
}

function UndoPreview({ approval }: { approval: ApprovalRequest }) {
  const i = (approval.toolInput ?? {}) as { changeId?: string; reason?: string };
  const [e, setE] = useState<{ summary: string; ts: string; undo?: { kind: string; name?: string } } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (!i.changeId) return;
    api
      .getAdminAudit(i.changeId)
      .then((x) => live && setE(x))
      .catch(() => live && setE(null));
    return () => {
      live = false;
    };
  }, [i.changeId]);
  return (
    <div className={styles.proposal}>
      <div className={styles.proposalHead}>
        <b>Revert admin change {i.changeId}</b>
      </div>
      {i.reason && <div className={styles.proposalHead}>Reason: {i.reason}</div>}
      <pre className={styles.proposalBody}>
        {e === undefined ? '…' : e === null ? '(entry not found)' : `${e.ts.slice(0, 16).replace('T', ' ')}  ${e.summary}\nrestores: ${e.undo?.kind ?? 'nothing'}${e.undo?.name ? ` "${e.undo.name}"` : ''}`}
      </pre>
    </div>
  );
}

function PlatformActionPreview({ approval }: { approval: ApprovalRequest }) {
  if (approval.toolName === PROPOSE_SETTINGS_TOOL) return <SettingsPreview approval={approval} />;
  if (approval.toolName === PROPOSE_UNDO_TOOL) return <UndoPreview approval={approval} />;
  if (approval.toolName === PROPOSE_TASK_TOOL) return <TaskStartPreview approval={approval} />;
  if (approval.toolName === PROPOSE_BATCH_TOOL) return <BatchPreview approval={approval} />;
  if (approval.toolName === PROPOSE_CLEANUP_TOOL) return <CleanupPreview approval={approval} />;
  if (approval.toolName === PROPOSE_PROVIDER_TOOL) return <ProviderPreview approval={approval} />;
  if (approval.toolName === PROPOSE_SCHEDULE_TOOL) return <SchedulePreview approval={approval} />;
  if (approval.toolName === PROPOSE_CHANNEL_TOOL) return <ChannelPreview approval={approval} />;
  if (approval.toolName === PROPOSE_RESOURCE_TOOL) return <ResourcePreview approval={approval} />;
  if (approval.toolName === PROPOSE_PACK_INSTALL_TOOL) return <PackPreview approval={approval} />;
  return <TaskActionPreview approval={approval} />;
}

function TaskActionPreview({ approval }: { approval: ApprovalRequest }) {
  const input = (approval.toolInput ?? {}) as { action?: string; taskIds?: string[]; name?: string; reason?: string };
  const isTasks = approval.toolName === PROPOSE_TASK_ACTION_TOOL;
  const ids = Array.isArray(input.taskIds) ? input.taskIds.map(String) : [];
  const [rows, setRows] = useState<{ id: string; label: string }[] | null>(null);
  useEffect(() => {
    if (!isTasks) return;
    let live = true;
    Promise.all(
      ids.slice(0, PREVIEW_TASKS).map((id) =>
        api
          .getTask(id)
          .then((t) => ({ id, label: `${t.title} — ${t.status}` }))
          .catch(() => ({ id, label: '(not found)' })),
      ),
    ).then((r) => live && setRows(r));
    return () => {
      live = false;
    };
  }, [isTasks, ids.join(',')]);
  return (
    <div className={styles.proposal}>
      {isTasks ? (
        <>
          <div className={styles.proposalHead}>
            <b>{input.action === 'delete' ? 'Delete' : 'Cancel'} {ids.length} task(s)</b>
            {input.action === 'delete' && ' — irreversible (transcripts and worktrees are removed)'}
          </div>
          {input.reason && <div className={styles.proposalHead}>Reason: {input.reason}</div>}
          <pre className={styles.proposalBody}>
            {(rows ?? ids.slice(0, PREVIEW_TASKS).map((id) => ({ id, label: '…' })))
              .map((r) => `${r.id}  ${r.label}`)
              .join('\n')}
            {ids.length > PREVIEW_TASKS ? `\n… and ${ids.length - PREVIEW_TASKS} more` : ''}
          </pre>
        </>
      ) : (
        <>
          <div className={styles.proposalHead}>
            Delete agent <b>{input.name}</b> (a snapshot is kept)
          </div>
          {input.reason && <div className={styles.proposalHead}>Reason: {input.reason}</div>}
        </>
      )}
    </div>
  );
}

export function ApprovalCard({
  approval,
  showTask = false,
  onGone,
}: {
  approval: ApprovalRequest;
  showTask?: boolean;
  /** Called when the approval is already gone/resolved (stale card → dismiss). */
  onGone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskException, setTaskException] = useState(false);
  const [globalException, setGlobalException] = useState(false);
  // Avoid setState after the card unmounts (the socket resolution removes it).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isContentProposal = approval.toolName === PROPOSE_AGENT_TOOL || approval.toolName === PROPOSE_SKILL_TOOL;
  const isPlatformAction =
    approval.toolName === PROPOSE_TASK_ACTION_TOOL ||
    approval.toolName === PROPOSE_AGENT_DELETE_TOOL ||
    approval.toolName === PROPOSE_CLEANUP_TOOL ||
    approval.toolName === PROPOSE_SETTINGS_TOOL ||
    approval.toolName === PROPOSE_UNDO_TOOL ||
    approval.toolName === PROPOSE_TASK_TOOL ||
    approval.toolName === PROPOSE_BATCH_TOOL ||
    approval.toolName === PROPOSE_PROVIDER_TOOL ||
    approval.toolName === PROPOSE_SCHEDULE_TOOL ||
    approval.toolName === PROPOSE_CHANNEL_TOOL ||
    approval.toolName === PROPOSE_RESOURCE_TOOL ||
    approval.toolName === PROPOSE_PACK_INSTALL_TOOL;
  const isSecret = approval.toolName === REQUEST_SECRET_TOOL;
  const isProposal = isContentProposal || isPlatformAction || isSecret;

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      // Exceptions only apply when approving.
      const opts =
        decision === 'approve' ? { taskException, globalException } : undefined;
      await api.decide(approval.id, decision, opts);
      // The resolution arrives over the socket and re-renders the lists.
    } catch (e) {
      const msg = (e as Error).message;
      // Already resolved (409) or gone/task-deleted (404) → the card is stale;
      // dismiss it instead of showing a scary error.
      if (/\b404\b|\b409\b|not found|already resolved/i.test(msg)) {
        onGone?.();
        return;
      }
      if (mounted.current) setError(msg);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className={styles.approval}>
      <div className={styles.reason}>⚠ {approval.reason}</div>
      <div className={styles.cmd}>{approval.summary}</div>
      {isContentProposal && <ProposalPreview approval={approval} />}
      {isPlatformAction && <PlatformActionPreview approval={approval} />}
      {isSecret && <SecretEntry approval={approval} onDone={() => undefined} onError={(m) => setError(m)} />}
      {showTask && <Muted className={styles.task}>task {approval.taskId}</Muted>}

      {approval.toolName !== CONTINUE_RUN_TOOL && !isProposal && (
      <details className={styles.options}>
        <summary className={styles.optionsSummary}>Options</summary>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={taskException}
            onChange={(e) => setTaskException(e.target.checked)}
          />
          <span>Don&rsquo;t ask again for this exact call in this task</span>
        </label>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={globalException}
            onChange={(e) => setGlobalException(e.target.checked)}
          />
          <span>Don&rsquo;t ask again for this exact call anywhere (global; expires after 30 days by default)</span>
        </label>
      </details>
      )}

      <Row>
        {!isSecret && (
          <Button variant="green" disabled={busy} onClick={() => decide('approve')}>
            Approve
          </Button>
        )}
        <Button variant="red" disabled={busy} onClick={() => decide('deny')}>
          {isSecret ? 'Cancel' : 'Deny'}
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
    </div>
  );
}
