import { useEffect, useState } from 'react';
import { SERVER_EVENT, CLIENT_EVENT, type ApprovalRequest } from '@lds/shared';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { ApprovalCard } from '@/components/ApprovalCard';
import styles from './ApprovalDock.module.css';

/**
 * Global, fixed-position dock of pending approvals shown on every page. Fed by
 * the `global` socket room, so a dangerous tool call surfaces wherever the user
 * is. The icon pulses for attention, and while the window is unfocused the tab
 * title flashes; window focus is reported to the server so it can escalate
 * unattended approvals to channels.
 */
export function ApprovalDock() {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);

  // Pending approvals + live updates.
  useEffect(() => {
    let active = true;
    api
      .listApprovals('pending')
      .then((list) => active && setApprovals(list))
      .catch(() => undefined);

    const socket = getSocket();
    const onCreated = (e: { approval: ApprovalRequest }) => {
      setApprovals((prev) =>
        prev.some((a) => a.id === e.approval.id) ? prev : [...prev, e.approval],
      );
    };
    const onResolved = (e: { approvalId: string }) => {
      setApprovals((prev) => prev.filter((a) => a.id !== e.approvalId));
    };
    // A deleted task cascade-removes its approvals with no resolve event — drop
    // any cards for it so they can't go stale (→ 404 on click).
    const onTaskDeleted = (e: { taskId: string }) => {
      setApprovals((prev) => prev.filter((a) => a.taskId !== e.taskId));
    };
    socket.on(SERVER_EVENT.approvalCreated, onCreated);
    socket.on(SERVER_EVENT.approvalResolved, onResolved);
    socket.on(SERVER_EVENT.taskDeleted, onTaskDeleted);
    return () => {
      active = false;
      socket.off(SERVER_EVENT.approvalCreated, onCreated);
      socket.off(SERVER_EVENT.approvalResolved, onResolved);
      socket.off(SERVER_EVENT.taskDeleted, onTaskDeleted);
    };
  }, []);

  // Report window focus to the server (drives channel escalation of unattended
  // approvals), sending the initial state on (re)connect.
  useEffect(() => {
    const socket = getSocket();
    const sendFocus = () => socket.emit(CLIENT_EVENT.focus);
    const sendBlur = () => socket.emit(CLIENT_EVENT.blur);
    const syncNow = () => (document.hasFocus() ? sendFocus() : sendBlur());
    window.addEventListener('focus', sendFocus);
    window.addEventListener('blur', sendBlur);
    socket.on('connect', syncNow);
    syncNow();
    return () => {
      window.removeEventListener('focus', sendFocus);
      window.removeEventListener('blur', sendBlur);
      socket.off('connect', syncNow);
    };
  }, []);

  // Flash the tab title while approvals are pending and the window is unfocused.
  useEffect(() => {
    if (approvals.length === 0) return;
    const original = document.title;
    let on = false;
    const tick = () => {
      if (document.hasFocus()) {
        document.title = original;
        return;
      }
      on = !on;
      document.title = on ? `⚠ (${approvals.length}) Approval needed` : original;
    };
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
      document.title = original;
    };
  }, [approvals.length]);

  if (approvals.length === 0) return null;

  return (
    <div className={styles.dock} role="region" aria-label="Pending approvals">
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden>
          ⚠
        </span>
        Approvals needed ({approvals.length})
      </div>
      <div className={styles.list}>
        {approvals.map((a) => (
          <ApprovalCard
            key={a.id}
            approval={a}
            showTask
            onGone={() => setApprovals((prev) => prev.filter((x) => x.id !== a.id))}
          />
        ))}
      </div>
    </div>
  );
}
