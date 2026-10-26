import { useEffect, useRef, useState } from 'react';
import { CLIENT_EVENT, SERVER_EVENT, type AgentLogEvent } from '@lds/shared';
import { api } from './api';
import { getSocket } from './socket';
import { mergeLines } from './merge-lines';
import { alertForMessage } from './alert-sound';

/** A transcript entry in the neutral shape both the history fetch and the socket produce. */
export interface StreamEntry {
  id: string;
  kind: string;
  text: string;
  attachments?: string[];
  speaker?: string;
  ts?: string;
}

/** Stable de-dup key — the same line can arrive via fetch and over the socket. */
export const lineKey = (sessionId: string, seq: number) => `${sessionId}:${seq}`;

/**
 * One task's transcript: history fetch + live socket lines, merged by key (`mergeLines`), so lines
 * that arrive while the history loads are kept. After every (re)connect it re-joins the room AND
 * refetches the history, so whatever was missed during the break is filled in (idempotent).
 * `toItem` maps an entry to the caller's line type (return null to skip it).
 */
export function useTaskStream<T extends { id: string }>(
  taskId: string | null,
  toItem: (e: StreamEntry) => T | null,
  opts: { onLive?: (e: AgentLogEvent) => void; onReconnect?: () => void } = {},
): { items: T[]; activityAt: number } {
  const [items, setItems] = useState<T[]>([]);
  // Last time anything arrived from the agent, for the "no reply" notice.
  const [activityAt, setActivityAt] = useState(() => Date.now());
  const toItemRef = useRef(toItem);
  toItemRef.current = toItem;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    setItems([]);
    if (!taskId) return;
    let active = true;
    let req = 0;
    const seen = new Set<string>(); // ids already shown (history + live)

    const loadHistory = () => {
      const mine = ++req;
      api
        .transcript(taskId)
        .then((events) => {
          // a late, older response must not overwrite a newer one
          if (!active || mine !== req) return;
          const history: T[] = [];
          for (const e of events) {
            const it = toItemRef.current({
              id: lineKey(e.agentSessionId, e.seq),
              kind: e.kind,
              text: e.text,
              attachments: e.attachments,
              speaker: e.speaker ?? undefined,
              ts: e.createdAt,
            });
            if (it) {
              history.push(it);
              seen.add(it.id);
            }
          }
          setItems((live) => mergeLines(history, live));
        })
        .catch(() => undefined);
    };

    const socket = getSocket();
    const onLog = (e: AgentLogEvent) => {
      if (e.taskId !== taskId) return;
      setActivityAt(Date.now());
      const it = toItemRef.current({ id: lineKey(e.agentSessionId, e.seq), kind: e.kind, text: e.text, attachments: e.attachments, speaker: e.speaker, ts: e.ts });
      if (it && !seen.has(it.id)) {
        seen.add(it.id);
        setItems((prev) => [...prev, it]);
        void alertForMessage(e.kind); // a sound for a new message of an agent — never for its steps
      }
      optsRef.current.onLive?.(e);
    };
    const subscribe = () => socket.emit(CLIENT_EVENT.subscribeTask, taskId);
    // Subscribe before fetching: nothing falls between the two (duplicates are merged by key).
    socket.on(SERVER_EVENT.agentLog, onLog);
    subscribe();
    loadHistory();
    // Re-join the room after a reconnect and fill in what was missed meanwhile.
    const onConnect = () => {
      subscribe();
      loadHistory();
      optsRef.current.onReconnect?.();
    };
    socket.on('connect', onConnect);

    return () => {
      active = false;
      socket.emit(CLIENT_EVENT.unsubscribeTask, taskId);
      socket.off('connect', onConnect);
      socket.off(SERVER_EVENT.agentLog, onLog);
    };
  }, [taskId]);

  return { items, activityAt };
}
