/**
 * One thing at a time per task: the worker bringing a checkout back and the cleanup removing one must not interleave (the cleanup reads the task's state and removes
 * the folder INSIDE the lock; the worker restores / checks the folder inside the same lock).
 */
export class TaskLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const result = prev.catch(() => undefined).then(fn);
    const tail = result.catch(() => undefined);
    this.tails.set(id, tail);
    void tail.then(() => {
      if (this.tails.get(id) === tail) this.tails.delete(id);
    });
    return result;
  }
}
