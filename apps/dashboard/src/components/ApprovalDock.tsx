import { useCallback, useEffect, useState } from 'react';
import { SERVER_EVENT, CLIENT_EVENT, type AgentQuestion, type ApprovalRequest } from '@lds/shared';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { usePolling } from '@/lib/use-polling';
import { alertForRequest, installAlertUnlock } from '@/lib/alert-sound';
import { ApprovalCard } from '@/components/ApprovalCard';
import { QuestionCard } from '@/components/QuestionCard';
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
  // Questions agents asked (ask_user) share the dock: the person is needed either way.
  const [questions, setQuestions] = useState<AgentQuestion[]>([]);
  useEffect(() => {
    let active = true;
    api
      .listQuestions('pending')
      .then((list) => active && setQuestions(list))
      .catch(() => undefined);
    const socket = getSocket();
    const onAsked = (e: { question: AgentQuestion }) => {
      setQuestions((prev) => (prev.some((q) => q.id === e.question.id) ? prev : [...prev, e.question]));
      void alertForRequest('question');
    };
    const onDone = (e: { question: AgentQuestion }) => setQuestions((prev) => prev.filter((q) => q.id !== e.question.id));
    const onTaskGone = (e: { taskId: string }) => setQuestions((prev) => prev.filter((q) => q.taskId !== e.taskId));
    socket.on(SERVER_EVENT.questionCreated, onAsked);
    socket.on(SERVER_EVENT.questionResolved, onDone);
    socket.on(SERVER_EVENT.taskDeleted, onTaskGone);
    return () => {
      active = false;
      socket.off(SERVER_EVENT.questionCreated, onAsked);
      socket.off(SERVER_EVENT.questionResolved, onDone);
      socket.off(SERVER_EVENT.taskDeleted, onTaskGone);
    };
  }, []);

  // The truth is the server's list of pending items. Socket events keep it live, but an event is lost whenever the connection is
  // (a laptop that slept, a phone tab in the background, an idle WebSocket closed by a proxy such as Cloudflare): a card whose
  // approval was decided elsewhere (Telegram, another tab, a timeout) would then hang here until a reload. So the list is re-read on
  // every (re)connect, when the tab comes back, and every 30 s while it is visible.
  const refresh = useCallback(() => {
    api.listApprovals('pending').then(setApprovals).catch(() => undefined);
    api.listQuestions('pending').then(setQuestions).catch(() => undefined);
  }, []);
  usePolling(refresh, 30_000);
  useEffect(() => {
    const socket = getSocket();
    socket.on('connect', refresh);
    return () => {
      socket.off('connect', refresh);
    };
  }, [refresh]);

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
      void alertForRequest('approval'); // the sound the person chose in Settings → General → Alert sound
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

  // The first touch of the page wakes the audio, so the alert sound can play by itself later.
  useEffect(() => installAlertUnlock(), []);

  // Report to the server whether the dashboard is in front of someone (drives the «dashboard first» delay of approvals and questions before they go to a
  // chat), sending the initial state on (re)connect. «In front» = the tab is VISIBLE, not that the window has the keyboard focus: a person who clicked into
  // a terminal on the same screen still sees the page, and must get the 10 seconds to answer there before Telegram is bothered.
  useEffect(() => {
    const socket = getSocket();
    const syncNow = () => socket.emit(document.visibilityState === 'visible' ? CLIENT_EVENT.focus : CLIENT_EVENT.blur);
    document.addEventListener('visibilitychange', syncNow);
    window.addEventListener('pageshow', syncNow);
    const hide = () => socket.emit(CLIENT_EVENT.blur);
    window.addEventListener('pagehide', hide);
    socket.on('connect', syncNow);
    syncNow();
    return () => {
      document.removeEventListener('visibilitychange', syncNow);
      window.removeEventListener('pageshow', syncNow);
      window.removeEventListener('pagehide', hide);
      socket.off('connect', syncNow);
    };
  }, []);

  // Flash the tab title while approvals are pending and the window is unfocused.
  useEffect(() => {
    if (approvals.length + questions.length === 0) return;
    const original = document.title;
    let on = false;
    const tick = () => {
      if (document.hasFocus()) {
        document.title = original;
        return;
      }
      on = !on;
      document.title = on ? `⚠ (${approvals.length + questions.length}) ${questions.length ? 'Question' : 'Approval needed'}` : original;
    };
    const id = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(id);
      document.title = original;
    };
  }, [approvals.length, questions.length]);

  if (approvals.length + questions.length === 0) return null;

  return (
    <div className={styles.dock} role="region" aria-label="Pending approvals">
      <div className={styles.header}>
        <span className={styles.icon} aria-hidden>
          ⚠
        </span>
        {questions.length && !approvals.length ? 'Questions' : 'Approvals needed'} ({approvals.length + questions.length})
      </div>
      <div className={styles.list}>
        {questions.map((q) => (
          <QuestionCard key={q.id} question={q} showTask onGone={() => setQuestions((prev) => prev.filter((x) => x.id !== q.id))} />
        ))}
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
