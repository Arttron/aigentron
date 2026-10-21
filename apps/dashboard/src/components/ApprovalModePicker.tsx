import { useCallback, useEffect, useState } from 'react';
import { api, type ApprovalLevelView } from '@/lib/api';
import { Muted } from '@/components/ui';
import styles from './ApprovalModePicker.module.css';

type Scope = { task: string } | { project: string };

const SOURCE: Record<ApprovalLevelView['source'], string> = {
  task: 'this task',
  ancestor: 'the lead task',
  project: 'the project',
  global: 'the global setting',
  default: 'the default',
};

/**
 * Approvals at one level: a task (its subtasks follow it) or a project. "Inherit" follows the level above (task → lead → project → global);
 * "Ask" / "No approvals" override it, in either direction.
 */
export function ApprovalModePicker({ scope, compact }: { scope: Scope; compact?: boolean }) {
  const [view, setView] = useState<ApprovalLevelView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = 'task' in scope ? `t:${scope.task}` : `p:${scope.project}`;

  const load = useCallback(async () => {
    try {
      setView('task' in scope ? await api.getTaskApprovalMode(scope.task) : await api.getProjectApprovalMode(scope.project));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [key]);
  useEffect(() => {
    void load();
  }, [load]);

  const change = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const mode = value === 'inherit' ? null : (value as 'ask' | 'off');
      setView('task' in scope ? await api.setTaskApprovalMode(scope.task, mode) : await api.setProjectApprovalMode(scope.project, mode));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return error ? <Muted>{error}</Muted> : null;
  const inheritedNow = `${view.effective === 'off' ? 'no approvals' : 'ask'}, from ${SOURCE[view.source]}${view.sourceName ? ` “${view.sourceName}”` : ''}`;
  // the full explanation lives in the tooltip; the options stay short so a header never stretches
  const short = view.effective === 'off' ? 'off' : 'ask';
  return (
    <label className={styles.picker} title={`Whether the agent asks before a risky action. A task's setting also covers its subtasks. Now: ${inheritedNow}${view.own ? ' (set here)' : ''}.`}>
      {!compact && <span>🛡 Approvals</span>}
      <select className={compact ? styles.select : styles.selectWide} value={view.own ?? 'inherit'} disabled={busy} onChange={(e) => void change(e.target.value)} aria-label="Approvals">
        <option value="inherit">{compact ? `Inherit (${short})` : `Inherit (${inheritedNow})`}</option>
        <option value="ask">{compact ? 'Ask' : 'Ask before risky actions'}</option>
        <option value="off">No approvals</option>
      </select>
      {error && <span className={styles.err}>{error}</span>}
    </label>
  );
}
