import { useEffect, useRef, useState } from 'react';
import { CONTINUE_RUN_TOOL, type ApprovalRequest } from '@lds/shared';
import { api } from '@/lib/api';
import { Button, Row, Muted, ErrorText } from '@/components/ui';
import styles from './ApprovalCard.module.css';

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
      {showTask && <Muted className={styles.task}>task {approval.taskId}</Muted>}

      {approval.toolName !== CONTINUE_RUN_TOOL && (
      <details className={styles.options}>
        <summary className={styles.optionsSummary}>Options</summary>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={taskException}
            onChange={(e) => setTaskException(e.target.checked)}
          />
          <span>Don&rsquo;t ask again for this in this task</span>
        </label>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={globalException}
            onChange={(e) => setGlobalException(e.target.checked)}
          />
          <span>Don&rsquo;t ask again for this anywhere (global)</span>
        </label>
      </details>
      )}

      <Row>
        <Button variant="green" disabled={busy} onClick={() => decide('approve')}>
          Approve
        </Button>
        <Button variant="red" disabled={busy} onClick={() => decide('deny')}>
          Deny
        </Button>
        {error && <ErrorText>{error}</ErrorText>}
      </Row>
    </div>
  );
}
