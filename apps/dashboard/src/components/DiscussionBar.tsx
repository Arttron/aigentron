import { useEffect, useState } from 'react';
import { usePolling } from '@/lib/use-polling';
import { api } from '@/lib/api';
import { Button, Muted } from '@/components/ui';
import { speakerColor } from '@/components/Transcript';
import styles from './DiscussionBar.module.css';

type State = Awaited<ReturnType<typeof api.discussionState>>;

/** While agents talk in this chat: who is answering, how far it is, and the buttons to wrap up or stop. */
export function DiscussionBar({ taskId, running }: { taskId: string; running: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);

  const poll = () => void api.discussionState(taskId).then(setState).catch(() => undefined);
  useEffect(() => {
    if (!running) return setState(null);
    poll();
  }, [taskId, running]);
  usePolling(poll, 2500, running);

  if (!state?.active) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await fn().catch(() => undefined);
    setBusy(false);
  };
  return (
    <div className={styles.bar}>
      <span>
        💬 Discussion · turn {state.turn}/{state.total}
        {state.speaker && (
          <>
            {' '}
            · <strong style={{ color: speakerColor(state.speaker) }}>{state.speaker}</strong> is answering…
          </>
        )}
      </span>
      <span className={styles.buttons}>
        <Button size="sm" disabled={busy} onClick={() => void act(() => api.concludeDiscussion(taskId))}>
          Wrap up
        </Button>
        <Button size="sm" variant="red" disabled={busy} onClick={() => void act(() => api.stopDiscussion(taskId))}>
          Stop
        </Button>
      </span>
      <Muted className={styles.hint}>Write in the box below to join in — they will answer you first.</Muted>
    </div>
  );
}
