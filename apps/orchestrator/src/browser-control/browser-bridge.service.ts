import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { SERVER_EVENT } from '@lds/shared';

/** What the bridge needs of a socket (a Socket.IO socket in production, a fake in the tests). */
export interface BridgeSocket {
  id: string;
  emit(event: string, ...args: unknown[]): unknown;
}

interface Device {
  socket: BridgeSocket;
  deviceId: string;
  userId: string;
  front: boolean;
  seenAt: number;
}

interface Pending {
  resolve: (v: ExtResult) => void;
  timer: NodeJS.Timeout;
  socketId: string;
  taskId: string;
}

export interface ExtResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** the tab is on a host the command was not allowed for (the server asks for a grant and retries) */
  needsGrant?: string;
  needsUrl?: string;
  /** the level of access the tab's site needs (`read` / `interact`) */
  level?: string;
  /** the command would submit / commit something: what, so the person can decide (the command was NOT carried out) */
  needsSubmit?: { label: string; host: string; action?: string; fields: { label: string; value: string }[] };
}

/** What the browser says it is about to submit, cut down to what a card can show. */
function cleanSubmit(v: unknown): ExtResult['needsSubmit'] | undefined {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  if (!o || typeof o.host !== 'string') return undefined;
  const fields = Array.isArray(o.fields) ? o.fields.slice(0, 20).map((f) => ({ label: String((f as { label?: unknown }).label ?? '').slice(0, 60), value: String((f as { value?: unknown }).value ?? '').slice(0, 120) })) : [];
  return { label: String(o.label ?? 'a button').slice(0, 100), host: o.host.slice(0, 200), ...(typeof o.action === 'string' ? { action: o.action.slice(0, 300) } : {}), fields };
}

const LOCK_IDLE_MS = 3 * 60_000;
const STOP_MS = 10 * 60_000;

/**
 * The line to the person's browser extension: commands go out over its Socket.IO connection (`ext:command`), answers come back (`ext:result`).
 * One task at a time uses a browser (a lock that frees itself after three idle minutes); a Stop pressed in the extension ends a task's use of the
 * browser for ten minutes. Which browser: the one the person is in front of, else the one heard from last.
 */
@Injectable()
export class BrowserBridgeService {
  private readonly logger = new Logger(BrowserBridgeService.name);
  private readonly devices = new Map<string, Device>();
  private readonly pending = new Map<string, Pending>();
  /** device socket id → the task that holds it */
  private readonly locks = new Map<string, { taskId: string; at: number }>();
  private readonly stopped = new Map<string, number>();

  attach(socket: BridgeSocket, deviceId: string, userId: string): void {
    this.devices.set(socket.id, { socket, deviceId, userId, front: false, seenAt: Date.now() });
  }

  detach(socketId: string): void {
    this.devices.delete(socketId);
    this.locks.delete(socketId);
    for (const [id, p] of this.pending) if (p.socketId === socketId) this.settle(id, { ok: false, error: 'The browser extension disconnected.' });
  }

  setFront(socketId: string, front: boolean): void {
    const d = this.devices.get(socketId);
    if (d) {
      d.front = front;
      d.seenAt = Date.now();
    }
  }

  get connected(): number {
    return this.devices.size;
  }

  private pick(userId?: string): Device | null {
    // a task nobody owns (scheduled, from a channel) may use a browser only when exactly one person has one connected — never someone else's by luck
    const people = new Set([...this.devices.values()].map((d) => d.userId));
    if (!userId && people.size > 1) return null;
    const all = [...this.devices.values()].filter((d) => !userId || d.userId === userId);
    return all.sort((a, b) => Number(b.front) - Number(a.front) || b.seenAt - a.seenAt)[0] ?? null;
  }

  private settle(id: string, result: ExtResult): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(result);
  }

  /** The extension's answer. Only the socket the command went to may answer it. */
  onResult(socketId: string, msg: { id?: unknown; ok?: unknown; data?: unknown; error?: unknown; needsGrant?: unknown; needsUrl?: unknown; level?: unknown; needsSubmit?: unknown }): void {
    const id = typeof msg?.id === 'string' ? msg.id : '';
    const p = this.pending.get(id);
    if (!p || p.socketId !== socketId) return;
    const d = this.devices.get(socketId);
    if (d) d.seenAt = Date.now();
    this.settle(id, { ok: msg.ok === true, data: msg.data, ...(typeof msg.error === 'string' ? { error: msg.error.slice(0, 500) } : {}), ...(typeof msg.needsGrant === 'string' ? { needsGrant: msg.needsGrant.slice(0, 200) } : {}), ...(typeof msg.needsUrl === 'string' ? { needsUrl: msg.needsUrl.slice(0, 2000) } : {}), ...(msg.level === 'read' || msg.level === 'interact' ? { level: msg.level } : {}), ...(cleanSubmit(msg.needsSubmit) ? { needsSubmit: cleanSubmit(msg.needsSubmit) } : {}) });
  }

  /** The person pressed Stop: whatever task holds that browser is cut off for a while, and its waiting commands fail now. */
  onStop(socketId: string): void {
    const lock = this.locks.get(socketId);
    if (!lock) return;
    this.stopped.set(lock.taskId, Date.now());
    this.locks.delete(socketId);
    for (const [id, p] of this.pending) if (p.socketId === socketId) this.settle(id, { ok: false, error: 'The person pressed Stop.' });
    this.logger.log(`Browser control of task ${lock.taskId} stopped by the person`);
  }

  /** The person allowed agents again after a Stop: every task may use the browser. */
  onAllow(socketId: string): void {
    if (!this.devices.has(socketId)) return; // only an attached extension may lift a Stop
    this.stopped.clear();
  }

  /** Did the person stop this task's browser use recently? */
  isStopped(taskId: string, now = Date.now()): boolean {
    const at = this.stopped.get(taskId);
    if (at === undefined) return false;
    if (now - at > STOP_MS) {
      this.stopped.delete(taskId);
      return false;
    }
    return true;
  }

  /** The task is over (or the person allowed it again): it may use a browser again. */
  release(taskId: string): void {
    this.stopped.delete(taskId);
    for (const [sid, l] of this.locks) if (l.taskId === taskId) this.locks.delete(sid);
  }

  /** Send a command to the person's browser and wait for the answer. Throws a readable message when it cannot be done. */
  async call(taskId: string, tool: string, args: Record<string, unknown>, opts: { userId?: string; timeoutMs?: number } = {}): Promise<ExtResult> {
    if (this.isStopped(taskId)) throw new Error('The person pressed Stop in the browser extension — do not use the browser any more in this task; ask them what to do.');
    const dev = this.pick(opts.userId);
    if (!dev) throw new Error('No browser with the Aigentron extension is connected right now. Ask the person to open their browser (and check the extension is connected).');
    const now = Date.now();
    const held = this.locks.get(dev.socket.id);
    if (held && held.taskId !== taskId && now - held.at < LOCK_IDLE_MS) throw new Error('The browser is being used by another task right now — try again in a minute.');
    this.locks.set(dev.socket.id, { taskId, at: now });
    const id = randomUUID();
    return new Promise<ExtResult>((resolve) => {
      const timer = setTimeout(() => this.settle(id, { ok: false, error: `The browser did not answer within ${Math.round((opts.timeoutMs ?? 60_000) / 1000)} s.` }), opts.timeoutMs ?? 60_000);
      this.pending.set(id, { resolve, timer, socketId: dev.socket.id, taskId });
      dev.socket.emit(SERVER_EVENT.extCommand, { id, tool, args, taskId });
    });
  }
}
