/**
 * The hard run ceiling (`AGENT_RUN_TIMEOUT_MS`) as ACTIVE time (E-02): while
 * the agent waits for a human — an `ask_user` question, an approval in the
 * PreToolUse hook — the clock is paused, so a person answering 15 minutes
 * later does not find the run killed as "timed out" and the task `stalled`.
 * Holds are counted (a question and an approval may overlap); the timer is
 * re-armed with the remaining active time when the last hold is released.
 * No Nest/Prisma: unit-tested with fake timers.
 */
export class RunDeadline {
  private timer: NodeJS.Timeout | null = null;
  private remainingMs: number;
  private armedAt = 0;
  private holds = 0;
  private started = false;
  private done = false;
  private pausedAt = 0;
  private pausedTotalMs = 0;

  constructor(
    totalMs: number,
    private readonly onExpire: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.remainingMs = totalMs;
  }

  /** Arm the ceiling (counts from now). */
  start(): void {
    if (this.started || this.done) return;
    this.started = true;
    if (this.holds === 0) this.arm();
  }

  /** The agent is waiting on a human: stop the clock. */
  pause(): void {
    this.holds++;
    if (this.holds > 1 || this.done) return;
    this.pausedAt = this.now();
    if (this.timer) {
      this.remainingMs = Math.max(0, this.remainingMs - (this.now() - this.armedAt));
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** The human answered: the clock runs again from where it stopped. */
  resume(): void {
    if (this.holds === 0) return;
    this.holds--;
    if (this.holds > 0 || this.done) return;
    this.pausedTotalMs += this.now() - this.pausedAt;
    if (this.started) this.arm();
  }

  get paused(): boolean {
    return this.holds > 0;
  }

  /** Total time the clock was stopped so far (for the transcript note). */
  get waitedMs(): number {
    return this.pausedTotalMs + (this.holds > 0 ? this.now() - this.pausedAt : 0);
  }

  /** The run is over: never fire. */
  clear(): void {
    this.done = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    this.armedAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.done) return;
      this.done = true;
      this.onExpire();
    }, this.remainingMs);
    this.timer.unref?.();
  }
}
