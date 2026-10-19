import { ACTIVE_PHASES, classifyLoginInput, findClaudeToken, tailForError, type LoginHints, type LoginPhase, type LoginView } from './login-core';

/** The slice of a child process a session needs (a fake in tests). */
export interface LoginChild {
  onOutput(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(text: string): void;
  kill(): void;
}

/** One kind of sign-in (Codex device code, Claude setup-token…). Created per provider, so it knows where to put the result. */
export interface LoginDriver {
  /** The person must paste something back (a code / the failed callback address). */
  readonly needsCode: boolean;
  /** What the CLI's output so far tells: the link, a device code, a credential. */
  interpret(output: string): LoginHints;
  /** The credential was obtained (`token` when the CLI prints one) — store it. Resolves to a sentence for the person. */
  finish(result: { token?: string }): Promise<string>;
  /** `true` = finish as soon as a credential appears (the CLI prints it and waits), else when the process exits with 0. */
  readonly finishOnToken: boolean;
}

const MAX_OUTPUT = 64 * 1024;
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * One sign-in attempt: starts the CLI, turns its output into what a person sees (link, code, a box to paste into), forwards what
 * they paste, and stores the credential through the driver. Secrets stay inside: `view()` never contains them.
 */
export class LoginSession {
  private phase: LoginPhase = 'starting';
  private message = 'Starting the sign-in…';
  private url: string | null = null;
  private userCode: string | null = null;
  private output = '';
  private child: LoginChild | null = null;
  private timer?: NodeJS.Timeout;
  private readonly startedAt = new Date();
  private finishedAt: Date | null = null;
  private finalizing = false;

  constructor(
    private readonly driver: LoginDriver,
    private readonly spawn: () => LoginChild,
    private readonly callbackFetch: (url: string) => Promise<void>,
    private readonly onSettled: () => void = () => undefined,
    private readonly timeoutMs: number = LOGIN_TIMEOUT_MS,
  ) {}

  get active(): boolean {
    return ACTIVE_PHASES.includes(this.phase);
  }

  start(): void {
    try {
      this.child = this.spawn();
    } catch (err) {
      this.settle('failed', `Could not start the sign-in: ${(err as Error).message}`);
      return;
    }
    this.child.onOutput((chunk) => this.onChunk(chunk));
    this.child.onExit((code) => void this.onExit(code));
    this.timer = setTimeout(() => this.fail('The sign-in was not completed within 10 minutes.'), this.timeoutMs);
    this.timer.unref?.();
  }

  view(): LoginView {
    return {
      phase: this.phase,
      url: this.url,
      userCode: this.userCode,
      needsCode: this.driver.needsCode && this.phase === 'awaiting_code',
      message: this.message,
      startedAt: this.startedAt.toISOString(),
      finishedAt: this.finishedAt?.toISOString() ?? null,
    };
  }

  private onChunk(chunk: string): void {
    if (!this.active) return;
    this.output = (this.output + chunk).slice(-MAX_OUTPUT);
    const hints = this.driver.interpret(this.output);
    if (hints.url && !this.url) {
      this.url = hints.url;
      this.phase = this.driver.needsCode ? 'awaiting_code' : 'awaiting_browser';
      this.message = this.driver.needsCode ? 'Open the link, sign in, then paste the code you get back here.' : 'Open the link and sign in.';
    }
    if (hints.userCode && !this.userCode) {
      this.userCode = hints.userCode;
      this.message = 'Open the link and enter the code.';
    }
    if (hints.token && this.driver.finishOnToken) void this.complete(hints.token);
  }

  /** What the person pasted: a code for the CLI, or the failed localhost address (the server makes that request itself). */
  async submit(raw: string): Promise<void> {
    if (this.phase !== 'awaiting_code') throw new Error('The sign-in is not waiting for a code.');
    const input = classifyLoginInput(raw);
    if (input.kind === 'invalid') throw new Error(input.why);
    this.phase = 'finishing';
    this.message = 'Checking the code…';
    if (input.kind === 'stdin') {
      this.child?.write(`${input.text}\r`);
      return;
    }
    try {
      await this.callbackFetch(input.url);
    } catch (err) {
      this.phase = 'awaiting_code';
      this.message = `The sign-in did not accept that address (${(err as Error).message}). Is the sign-in still running? Start it again if it timed out.`;
      throw new Error(this.message);
    }
  }

  cancel(): void {
    if (!this.active) return;
    this.settle('cancelled', 'Sign-in cancelled.');
  }

  private async onExit(code: number | null): Promise<void> {
    if (!this.active || this.finalizing) return;
    if (code === 0) {
      await this.complete(findClaudeToken(this.output) ?? undefined);
      return;
    }
    const why = tailForError(this.output);
    this.settle('failed', `The sign-in did not finish${why ? `: ${why}` : '.'}`);
  }

  private async complete(token?: string): Promise<void> {
    if (!this.active || this.finalizing) return;
    this.finalizing = true;
    this.phase = 'finishing';
    this.message = 'Saving the sign-in…';
    try {
      const message = await this.driver.finish({ token });
      this.settle('done', message);
    } catch (err) {
      this.settle('failed', `Signed in, but saving failed: ${(err as Error).message}`);
    }
  }

  private fail(message: string): void {
    if (this.active) this.settle('failed', message);
  }

  private settle(phase: LoginPhase, message: string): void {
    this.phase = phase;
    this.message = message;
    this.finishedAt = new Date();
    this.output = '';
    if (this.timer) clearTimeout(this.timer);
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
    this.onSettled();
  }
}
