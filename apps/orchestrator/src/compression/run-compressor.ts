import { compressText, type CompressionConfig } from '@lds/shared';

/** What our text filters saved over one run: characters before / after and, per rule, characters removed. */
export interface CompressionTotals {
  before: number;
  after: number;
  saved: Record<string, number>;
}

/**
 * The text filter of ONE run: applies the settings to what goes to the model (the person's message, the answers of bulky tools) and counts what it saved,
 * so the run's row can carry it to the Stats page. A tool call in a resumed or retried attempt adds to the same totals.
 */
export class RunCompressor {
  private readonly totals: CompressionTotals = { before: 0, after: 0, saved: {} };

  constructor(private readonly cfg: CompressionConfig) {}

  private apply(text: string, source: 'message' | 'tool'): string {
    const r = compressText(text, this.cfg, source);
    if (r.after < r.before) {
      this.totals.before += r.before;
      this.totals.after += r.after;
      for (const [k, v] of Object.entries(r.saved)) this.totals.saved[k] = (this.totals.saved[k] ?? 0) + v;
    }
    return r.text;
  }

  /** The person's message (or a follow-up) before it goes to the model. */
  message(text: string): string {
    return this.cfg.enabled && this.cfg.applyToMessages ? this.apply(text, 'message') : text;
  }

  /** The answer of a tool before the model reads it. */
  tool(_name: string, text: string): string {
    return this.cfg.enabled && this.cfg.applyToToolResults ? this.apply(text, 'tool') : text;
  }

  snapshot(): CompressionTotals {
    return { before: this.totals.before, after: this.totals.after, saved: { ...this.totals.saved } };
  }

  /** The columns of an AgentSession row for what was saved (empty when nothing was). */
  columns(): { compressionBefore?: number; compressionAfter?: number; compressionSaved?: string } {
    const t = this.totals;
    return t.before > t.after ? { compressionBefore: t.before, compressionAfter: t.after, compressionSaved: JSON.stringify(t.saved) } : {};
  }
}
