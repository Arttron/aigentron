import type { ProviderFailureKind } from './run-outcome';

/** How long a provider is considered unavailable after it failed in a way that will not fix itself at once. */
export const COOLDOWN_MS: Record<ProviderFailureKind, number> = {
  quota: 30 * 60_000, // the plan / balance / window is used up
  auth: 10 * 60_000, // a rejected key or token
  rate: 2 * 60_000, // a transient rate limit
  other: 0,
};

/**
 * Remembers providers that just failed with an exhausted quota, a rate limit or bad credentials, so the next runs start on a fallback
 * instead of failing first on the same provider (and burning a turn and the wait). In memory: it is a hint, not state.
 */
export class ProviderCooldown {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Marks a provider after a failure of the given kind; returns the cool-down in ms (0 = none). */
  mark(name: string, kind: ProviderFailureKind): number {
    const ms = COOLDOWN_MS[kind];
    if (ms > 0) this.until.set(name, this.now() + ms);
    return ms;
  }

  isCooling(name: string): boolean {
    const t = this.until.get(name);
    if (t === undefined) return false;
    if (t <= this.now()) {
      this.until.delete(name);
      return false;
    }
    return true;
  }

  /** Minutes left, for messages. */
  minutesLeft(name: string): number {
    const t = this.until.get(name);
    return t === undefined ? 0 : Math.max(0, Math.ceil((t - this.now()) / 60_000));
  }

  clear(name: string): void {
    this.until.delete(name);
  }
}
