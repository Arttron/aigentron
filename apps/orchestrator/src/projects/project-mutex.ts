/**
 * A FIFO mutex per key (docs/plan-projects-workspace.md §2.6): tasks of one shared-mode project take turns in its
 * checkout; tasks of different projects never wait for each other. In-process (the orchestrator is one process in both
 * queue drivers). Pure — tested in project-mutex.test.ts.
 */
export type Release = () => void;

export class KeyedMutex {
  /** The end of each key's queue (resolves when the last requester releases). */
  private readonly tails = new Map<string, Promise<void>>();
  /** Holders + waiters per key (0 = free). */
  private readonly users = new Map<string, number>();

  /** Who is in the queue of a key, holder included. */
  pending(key: string): number {
    return this.users.get(key) ?? 0;
  }

  /** Is anyone holding the key right now (or queued for it)? */
  busy(key: string): boolean {
    return this.pending(key) > 0;
  }

  /**
   * Take the key, waiting FIFO behind earlier requesters. `onWait` runs only when there IS something to wait for; what it
   * returns runs once the wait is over (acquired, whatever the reason) — the worker uses that pair to hand its slot to
   * other projects while it waits. The returned function releases the key (idempotent).
   */
  async acquire(key: string, onWait?: () => Release | void): Promise<Release> {
    const waits = this.busy(key);
    this.users.set(key, this.pending(key) + 1);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    if (waits) {
      const done = onWait?.();
      try {
        await prev;
      } finally {
        done?.();
      }
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.pending(key) - 1;
      if (left > 0) this.users.set(key, left);
      else {
        this.users.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      }
      release();
    };
  }
}
