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
  /** `decide` is out asking (the window ran out); the timer must not be re-armed until it answers */
  private deciding = false;

  /** All the active time granted so far: the first window plus every extension. */
  grantedMs: number;

  /**
   * `decide` is asked when a window runs out: a number of ms > 0 grants that much more (the run is still making progress), 0 lets it expire.
   * It may take its time (a person is asked): while it does, the run is neither extended nor expired.
   */
  constructor(
    totalMs: number,
    private readonly onExpire: () => void,
    private readonly now: () => number = Date.now,
    private readonly decide?: () => number | Promise<number>,
  ) {
    this.remainingMs = totalMs;
    this.grantedMs = totalMs;
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
    if (this.started && !this.deciding) this.arm();
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

  private expire(): void {
    this.done = true;
    this.onExpire();
  }

  private arm(): void {
    this.armedAt = this.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.done) return;
      if (!this.decide) return this.expire();
      this.deciding = true;
      Promise.resolve()
        .then(() => this.decide!())
        .catch(() => 0)
        .then((more) => {
          this.deciding = false;
          if (this.done) return;
          if (more > 0) {
            this.remainingMs = more;
            this.grantedMs += more;
            // someone else holds the clock (an approval is pending): resume() re-arms it
            if (this.holds === 0) this.arm();
          } else this.expire();
        });
    }, this.remainingMs);
    this.timer.unref?.();
  }
}
