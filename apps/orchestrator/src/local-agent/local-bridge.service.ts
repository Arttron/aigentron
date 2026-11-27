import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { LocalDevicesService } from './local-devices.service';
import type { LocalDevice } from './local-devices';
import { parseRepos, type RepoStatus } from './local-repos';
import { decodeFrame, encodeFrame, negotiate, PING_SEC, type Frame } from './local-agent-proto';

/** What the bridge needs of a socket (a `ws` socket in production, a fake in the tests). */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface CommandResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface LocalConnectionInfo {
  version?: string;
  os?: string;
  arch?: string;
  host?: string;
  /** the revision of the global rules this computer holds */
  configRev?: number;
  connectedAt: string;
}

interface Conn {
  sock: BridgeSocket;
  device: LocalDevice;
  ready: boolean;
  info?: LocalConnectionInfo;
  /** the picture of the computer's repositories, as it last reported it (event `repos`) */
  repos: RepoStatus[];
  reposAt?: string;
  lastHeard: number;
  timer?: NodeJS.Timeout;
}

interface Pending {
  resolve: (r: CommandResult) => void;
  timer: NodeJS.Timeout;
  deviceId: string;
  /** streamed output of the command (`event` frames the daemon sends while it runs); each one restarts the idle timer */
  onEvent?: (name: string, data: unknown) => void;
  idleMs?: number;
  fail?: () => void;
}

const HELLO_MS = 10_000;

/**
 * The line to the people's local agents: each paired daemon holds one WebSocket; commands go out (`command`), answers come back (`result`).
 * One connection per device (a newer one replaces the older). L0 knows the handshake, keep-alive and request/response; the repository operations come with later stages.
 */
@Injectable()
export class LocalBridgeService {
  private readonly logger = new Logger(LocalBridgeService.name);
  private readonly conns = new Map<string, Conn>();
  private readonly pending = new Map<string, Pending>();
  private readonly eventHooks: Array<(deviceId: string, name: string, data: unknown) => void> = [];
  private readonly readyHooks: Array<(deviceId: string, info: LocalConnectionInfo) => void> = [];

  constructor(private readonly devices: LocalDevicesService) {}

  get version(): string {
    return process.env.APP_VERSION ?? 'dev';
  }

  /** A device authenticated at the upgrade: returns the handlers the gateway wires to the socket's events. */
  attach(sock: BridgeSocket, device: LocalDevice): { message: (text: string) => void; close: () => void } {
    this.conns.get(device.id)?.sock.close(4409, 'replaced by a newer connection');
    const conn: Conn = { sock, device, ready: false, repos: [], lastHeard: Date.now() };
    this.conns.set(device.id, conn);
    const drop = (code: number, reason: string) => {
      try {
        sock.close(code, reason);
      } catch {
        /* already closed */
      }
    };
    const hello = setTimeout(() => !conn.ready && drop(4408, 'no hello'), HELLO_MS);
    hello.unref?.();
    const watch = () => {
      conn.timer = setTimeout(() => {
        if (Date.now() - conn.lastHeard > 3 * PING_SEC * 1000) drop(4408, 'silent');
        else watch();
      }, PING_SEC * 1000);
      conn.timer.unref?.();
    };
    watch();
    return {
      message: (text: string) => {
        conn.lastHeard = Date.now();
        const f = decodeFrame(text);
        if (!f) return drop(4400, 'bad frame');
        if (!conn.ready) {
          if (f.type !== 'hello') return drop(4400, 'expected hello');
          const answer = negotiate(f, this.version);
          sock.send(encodeFrame(answer));
          if (answer.type === 'refuse') return drop(4403, answer.code ?? 'refused');
          conn.ready = true;
          clearTimeout(hello);
          conn.info = { version: f.version, os: f.os, arch: f.arch, host: f.host, configRev: Number.isInteger(f.configRev) ? f.configRev : 0, connectedAt: new Date().toISOString() };
          this.devices.touch(device.id, conn.info, true);
          for (const hook of this.readyHooks) hook(device.id, conn.info);
          this.logger.log(`Local agent "${device.label}" is online (${f.os ?? '?'}/${f.arch ?? '?'} ${f.version ?? ''})`);
          return;
        }
        this.onFrame(conn, f);
      },
      close: () => {
        clearTimeout(hello);
        if (conn.timer) clearTimeout(conn.timer);
        if (this.conns.get(device.id) === conn) {
          this.conns.delete(device.id);
          this.failPending(device.id, 'the local agent disconnected');
        }
      },
    };
  }

  private onFrame(conn: Conn, f: Frame): void {
    switch (f.type) {
      case 'ping':
        conn.sock.send(encodeFrame({ type: 'pong', id: f.id }));
        return;
      case 'result': {
        const p = f.id ? this.pending.get(f.id) : undefined;
        if (!p || p.deviceId !== conn.device.id) return; // someone else's / late answer
        clearTimeout(p.timer);
        this.pending.delete(f.id!);
        p.resolve({ ok: f.ok === true, data: f.data, error: f.error });
        return;
      }
      case 'event': {
        if (f.name === 'llm.chunk') {
          const d = f.data as { id?: unknown } | undefined;
          const p = typeof d?.id === 'string' ? this.pending.get(d.id) : undefined;
          if (p && p.deviceId === conn.device.id && p.onEvent) {
            p.onEvent(f.name, f.data);
            p.timer.refresh();
          }
          return;
        }
        if (f.name === 'repos') {
          conn.repos = parseRepos(f.data);
          conn.reposAt = new Date().toISOString();
          return;
        }
        // anything else the computer reports (`notice`, `propose-commit`): whoever listens decides; a listener that throws must not break the line
        for (const hook of this.eventHooks) {
          try {
            hook(conn.device.id, f.name ?? '', f.data);
          } catch (e) {
            this.logger.warn(`a listener of "${f.name}" failed: ${(e as Error).message}`);
          }
        }
        return;
      }
      default:
        return; // pong: noted by lastHeard
    }
  }

  private failPending(deviceId: string, error: string): void {
    for (const [id, p] of this.pending) {
      if (p.deviceId !== deviceId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.resolve({ ok: false, error });
    }
  }

  /** The repositories a computer reported (empty when offline or none were added there). */
  repos(deviceId: string): RepoStatus[] {
    const c = this.conns.get(deviceId);
    return c?.ready ? c.repos : [];
  }

  reposAt(deviceId: string): string | null {
    return this.conns.get(deviceId)?.reposAt ?? null;
  }

  /** Called for the events of a ready computer other than `repos` and `llm.chunk`. */
  onEvent(hook: (deviceId: string, name: string, data: unknown) => void): void {
    this.eventHooks.push(hook);
  }

  /** Called when a device has completed its handshake (the rules service uses it to sync). */
  onReady(hook: (deviceId: string, info: LocalConnectionInfo) => void): void {
    this.readyHooks.push(hook);
  }

  onlineIds(): string[] {
    return [...this.conns].filter(([, c]) => c.ready).map(([id]) => id);
  }

  setConfigRev(deviceId: string, rev: number): void {
    const c = this.conns.get(deviceId);
    if (c?.info) c.info.configRev = rev;
  }

  isOnline(deviceId: string): boolean {
    return Boolean(this.conns.get(deviceId)?.ready);
  }

  connection(deviceId: string): LocalConnectionInfo | null {
    const c = this.conns.get(deviceId);
    return c?.ready && c.info ? c.info : null;
  }

  /** Ask a device to do something and wait for its answer (never rejects: an offline device or a timeout is `{ok:false}`). */
  request(deviceId: string, op: string, args: unknown = {}, timeoutMs = 15_000): Promise<CommandResult> {
    const c = this.conns.get(deviceId);
    if (!c?.ready) return Promise.resolve({ ok: false, error: 'the local agent is offline' });
    const id = randomUUID();
    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'the local agent did not answer in time' });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer, deviceId });
      try {
        c.sock.send(encodeFrame({ type: 'command', id, op, args }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `could not reach the local agent: ${(e as Error).message}` });
      }
    });
  }

  /**
   * Like `request`, for a command that streams (`llm.chat`): `build(id)` makes the arguments (the daemon tags its chunks with that id), `onEvent` gets each chunk,
   * and the timeout is an IDLE one — it restarts with every chunk, so a long answer is fine but a stalled one ends. `cancel()` tells the daemon to stop.
   */
  stream(deviceId: string, op: string, build: (id: string) => unknown, onEvent: (name: string, data: unknown) => void, idleMs = 120_000): { id: string; done: Promise<CommandResult>; cancel: () => void } {
    const c = this.conns.get(deviceId);
    const id = randomUUID();
    const cancel = (): void => {
      try {
        if (this.conns.get(deviceId)?.ready) c?.sock.send(encodeFrame({ type: 'command', id: randomUUID(), op: 'llm.cancel', args: { id } }));
      } catch {
        /* gone */
      }
    };
    if (!c?.ready) return { id, done: Promise.resolve({ ok: false, error: 'the local agent is offline' }), cancel };
    const done = new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cancel();
        resolve({ ok: false, error: 'the local model stopped answering' });
      }, idleMs);
      this.pending.set(id, { resolve, timer, deviceId, onEvent, idleMs });
      try {
        c.sock.send(encodeFrame({ type: 'command', id, op, args: build(id) }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `could not reach the local agent: ${(e as Error).message}` });
      }
    });
    return { id, done, cancel };
  }

  /** The device was removed on the dashboard: tell it (it stops reconnecting) and close the line. */
  revoke(deviceId: string): void {
    const c = this.conns.get(deviceId);
    if (!c) return;
    try {
      c.sock.send(encodeFrame({ type: 'refuse', code: 'revoked', message: 'this device was disconnected on the server' }));
      c.sock.close(4403, 'revoked');
    } catch {
      /* gone already */
    }
    this.conns.delete(deviceId);
    this.failPending(deviceId, 'the local agent was disconnected');
  }
}
