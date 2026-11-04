/**
 * The command pipeline's queue: heavy commands of every task wait here, first come first served, and only `slots()` of them run at once.
 * Before a command starts it passes the `gate` (the machine must not be busy). Waiting costs nothing; the person sees who is ahead.
 *
 * Pure of I/O: what runs, and what "the machine is busy" means, are handed in — so the order, the limit, the cancelling and the live change of the limit
 * are tested without a process or a clock.
 */
export interface QueueEntryInfo {
  id: number;
  taskId: string;
  label: string;
  /** whose command it is (the token of the attempt that asked) */
  owner?: string;
  state: 'waiting' | 'starting' | 'running';
  /** ms epoch */
  queuedAt: number;
  startedAt: number | null;
}

export interface QueueRunOptions {
  /** cancel while waiting (the command never starts) or while running (`exec` gets the same signal) */
  signal?: AbortSignal;
  /** told when the command has to wait: how many are ahead, and why it still waits when it is its turn but the machine is busy */
  onWait?: (info: { ahead: number; reason: string | null }) => void;
}

export class QueueAbortedError extends Error {
  constructor() {
    super('The command was cancelled while it waited in the queue.');
    this.name = 'QueueAbortedError';
  }
}

interface Entry<T> {
  info: QueueEntryInfo;
  exec: (signal: AbortSignal) => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  opts: QueueRunOptions;
  ctrl: AbortController;
}

export class CommandQueue {
  private seq = 0;
  private readonly waiting: Entry<unknown>[] = [];
  private readonly active = new Set<Entry<unknown>>();

  constructor(
    private readonly slots: () => number,
    /** resolves when the machine may take another heavy command; `onWait` is told why it has to wait */
    private readonly gate: (onWait: (reason: string) => void, signal: AbortSignal) => Promise<void> = async () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

  run<T>(job: { taskId: string; label: string; owner?: string }, exec: (signal: AbortSignal) => Promise<T>, opts: QueueRunOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ctrl = new AbortController();
      const entry: Entry<T> = { info: { id: ++this.seq, taskId: job.taskId, label: job.label, owner: job.owner, state: 'waiting', queuedAt: this.now(), startedAt: null }, exec, resolve, reject, opts, ctrl };
      if (opts.signal) {
        if (opts.signal.aborted) return reject(new QueueAbortedError());
        opts.signal.addEventListener('abort', () => this.cancel(entry as Entry<unknown>), { once: true });
      }
      this.waiting.push(entry as Entry<unknown>);
      opts.onWait?.({ ahead: this.ahead(entry as Entry<unknown>), reason: null });
      this.pump();
    });
  }

  /** What is running and what waits (for the task page and the stats). */
  snapshot(): { running: QueueEntryInfo[]; waiting: QueueEntryInfo[] } {
    return { running: [...this.active].map((e) => ({ ...e.info })), waiting: this.waiting.map((e) => ({ ...e.info })) };
  }

  /** The limit changed (Settings): a slot may be free now. */
  slotsChanged(): void {
    this.pump();
  }

  /** Cancel every command of a task (the task was stopped or deleted). */
  cancelTask(taskId: string): number {
    const mine = [...this.waiting, ...this.active].filter((e) => e.info.taskId === taskId);
    for (const e of mine) this.cancel(e);
    return mine.length;
  }

  /** Cancel the commands one attempt asked for (its token went away) — never those of another attempt of the same task. */
  cancelOwner(owner: string): number {
    const mine = [...this.waiting, ...this.active].filter((e) => e.info.owner === owner);
    for (const e of mine) this.cancel(e);
    return mine.length;
  }

  private ahead(e: Entry<unknown>): number {
    return this.active.size + this.waiting.indexOf(e);
  }

  private cancel(e: Entry<unknown>): void {
    const i = this.waiting.indexOf(e);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      e.reject(new QueueAbortedError());
      this.tellWaiting();
    } else e.ctrl.abort(); // running (or starting): the process is stopped through the signal
  }

  private tellWaiting(): void {
    this.waiting.forEach((e, i) => e.opts.onWait?.({ ahead: this.active.size + i, reason: null }));
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.active.size < Math.max(1, this.slots())) {
      const e = this.waiting.shift()!;
      this.active.add(e);
      e.info.state = 'starting';
      void this.start(e);
    }
  }

  private async start(e: Entry<unknown>): Promise<void> {
    try {
      // the slot is held while the machine is looked at, so the next command does not slip into the same calm moment
      await this.gate((reason) => e.opts.onWait?.({ ahead: 0, reason }), e.ctrl.signal);
      if (e.ctrl.signal.aborted) throw new QueueAbortedError();
      e.info.state = 'running';
      e.info.startedAt = this.now();
      e.resolve(await e.exec(e.ctrl.signal));
    } catch (err) {
      e.reject(err);
    } finally {
      this.active.delete(e);
      this.tellWaiting();
      this.pump();
    }
  }
}
