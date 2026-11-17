/**
 * A link to one message of a chat: `/tasks/<task id>?ev=<session id>:<seq>` — the same address the dashboard opens at that message (it scrolls to it and
 * highlights it). A person pastes it to an agent, the agent passes it to `read_message`, and the server finds the stored message. Pure.
 */

export interface MessageRef {
  taskId: string;
  sessionId: string;
  seq: number;
}

/** The dashboard's address of a message (relative; the dashboard puts its own origin in front when it copies the link). */
export const messageLink = (taskId: string, sessionId: string, seq: number): string => `/tasks/${encodeURIComponent(taskId)}?ev=${encodeURIComponent(`${sessionId}:${seq}`)}`;

const LINK = /\/tasks\/([\w-]{1,64})\?(?:[^\s#]*&)?ev=([\w%.:-]+)/;
const LINE = /^([\w-]{1,64}):(\d{1,9})$/;

/** The message a link (full URL, or just `/tasks/<id>?ev=…`, also inside a sentence) points at, or null when the text holds no such link. */
export function parseMessageLink(text: string): MessageRef | null {
  const m = LINK.exec(String(text ?? ''));
  if (!m) return null;
  let line: string;
  try {
    line = decodeURIComponent(m[2]!);
  } catch {
    return null;
  }
  const l = LINE.exec(line);
  return l ? { taskId: m[1]!, sessionId: l[1]!, seq: Number(l[2]) } : null;
}
