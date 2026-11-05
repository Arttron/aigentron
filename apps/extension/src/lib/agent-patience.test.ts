import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JavaScript module (the extension has no build step for its own sources)
import { actInPage, snapshotPage } from './agentpage.js';
// @ts-expect-error plain JavaScript module (chrome.* is only touched when a command runs)
import { quietly } from './agent.js';

const g = globalThis as unknown as { window?: unknown; document?: unknown };
afterEach(() => {
  delete g.window;
  delete g.document;
});

describe('quietly: waits for the person instead of refusing', () => {
  const sleep = async () => undefined;
  it("a moment of the person's own clicking is waited out; the agent never hears of it", async () => {
    const run = vi.fn().mockResolvedValueOnce({ ok: false, busy: true }).mockResolvedValueOnce({ ok: false, busy: true }).mockResolvedValueOnce({ ok: true, data: 1 });
    expect(await quietly(run, { sleep })).toEqual({ ok: true, data: 1 });
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('a person who keeps at it for the whole wait does get the refusal', async () => {
    const run = vi.fn(async () => ({ ok: false, busy: true, error: 'The person is using this tab' }));
    const r = await quietly(run, { tries: 4, sleep });
    expect(r.busy).toBe(true);
    expect(run).toHaveBeenCalledTimes(4);
  });
  it('any other answer is returned at once', async () => {
    const run = vi.fn(async () => ({ ok: false, error: 'not on the page any more' }));
    await quietly(run, { sleep });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('Stop pressed during the wait wins: nothing is done after it', async () => {
    const run = vi.fn(async () => ({ ok: false, busy: true }));
    let stopped = false;
    const r = await quietly(run, { sleep: async () => void (stopped = true), before: async () => (stopped ? { ok: false, error: 'The person pressed Stop.' } : null) });
    expect(r).toEqual({ ok: false, error: 'The person pressed Stop.' });
    expect(run).toHaveBeenCalledTimes(1); // the retry was never made
  });
});

/** A page that records what the person's hands do: the handlers actInPage / snapshotPage install, called like the browser would. */
function page(opts: { userAgo?: number; watchedFor?: number } = {}) {
  const handlers = new Map<string, (e: unknown) => void>();
  const win: Record<string, unknown> = {
    __aigentronRefs: new Map(),
    addEventListener: (t: string, h: (e: unknown) => void) => handlers.set(t, h),
  };
  if (opts.userAgo !== undefined) win.__aigentronUserAt = Date.now() - opts.userAgo;
  if (opts.watchedFor !== undefined) {
    win.__aigentronUserListener = true;
    win.__aigentronListenerAt = Date.now() - opts.watchedFor;
  }
  g.window = win;
  return { win, handlers, hand: (type: string, extra: Record<string, unknown> = {}) => handlers.get(type)?.({ type, isTrusted: true, buttons: 0, target: { closest: () => null }, ...extra }) };
}
const act = (a: Record<string, unknown>) => {
  try {
    return actInPage(a);
  } catch {
    return { ok: true }; // past the busy check (the fake page has no document): not "busy"
  }
};
const watch = () => {
  try {
    snapshotPage(); // installs the watch (it runs after every navigation, before any action)
  } catch {
    /* the fake page has no document to read: the watch was installed first */
  }
};

describe('actInPage: how quiet the person must be', () => {
  it('a click or key press a moment ago pauses it, a second and a half ago does not', () => {
    page({ userAgo: 300, watchedFor: 5000 });
    expect(act({ kind: 'scroll' })).toMatchObject({ ok: false, busy: true });
    page({ userAgo: 1200, watchedFor: 5000 });
    expect(act({ kind: 'scroll' }).busy).toBe(true);
    page({ userAgo: 1700, watchedFor: 5000 });
    expect(act({ kind: 'scroll' }).busy).toBeUndefined();
    page({ userAgo: 3000, watchedFor: 5000 });
    expect(act({ kind: 'scroll' }).busy).toBeUndefined(); // (was: refused for three seconds)
  });

  it('an action the person has JUST approved is not refused for their own click on the approval card', () => {
    page({ userAgo: 200, watchedFor: 5000 });
    expect(act({ kind: 'click', confirmed: true }).busy).toBeUndefined();
  });

  it('a page that has only just been watched is looked at first (a click made before the watch began would be unseen)', () => {
    page({ watchedFor: 100 });
    expect(act({ kind: 'click' })).toMatchObject({ busy: true });
    page({ watchedFor: 3000 });
    expect(act({ kind: 'click' }).busy).toBeUndefined();
  });
});

describe('what counts as the person using the tab', () => {
  const lastAt = (p: ReturnType<typeof page>) => p.win.__aigentronUserAt as number | undefined;
  it('a real click, key press, typing and a drag do; scrolling and a passing pointer do not', () => {
    for (const [type, extra, counts] of [
      ['pointerdown', {}, true],
      ['keydown', {}, true],
      ['beforeinput', {}, true],
      ['compositionupdate', {}, true],
      ['pointermove', { buttons: 1 }, true], // a drag
      ['pointermove', { buttons: 0 }, false], // a pointer that merely passes
      ['wheel', {}, false],
    ] as const) {
      const p = page();
      watch();
      p.hand(type, extra);
      expect(lastAt(p) !== undefined, `${type} ${JSON.stringify(extra)}`).toBe(counts);
    }
  });
  it('an event that is not a real one (a script made it) does not count', () => {
    const p = page();
    watch();
    p.hand('pointerdown', { isTrusted: false });
    expect(lastAt(p)).toBeUndefined();
  });
  it("a click on the extension's own card or frame (Approve, Stop) does not count", () => {
    const p = page();
    watch();
    p.hand('pointerdown', { target: { closest: (sel: string) => (sel === '[data-aigentron-ui]' ? {} : null) } });
    expect(lastAt(p)).toBeUndefined();
  });
  it("the agent's own typing (trusted input events made while it acts) does not count", () => {
    const p = page();
    watch();
    p.win.__aigentronActing = true;
    p.hand('beforeinput');
    expect(lastAt(p)).toBeUndefined();
  });
});
