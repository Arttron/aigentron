import { describe, expect, it } from 'vitest';
import { BROWSER_GRANT_TOOL, BROWSER_SUBMIT_TOOL } from '@lds/shared';
import { BrowserMcpService } from './browser-mcp.service';
import type { ExtResult } from './browser-bridge.service';

function make(opts: { verdicts?: string[]; calls?: ExtResult[]; allowByException?: boolean } = {}) {
  const asked: { toolName: string; toolInput: Record<string, unknown> }[] = [];
  const sent: { tool: string; args: Record<string, unknown> }[] = [];
  const verdicts = [...(opts.verdicts ?? ['approved'])];
  const calls = [...(opts.calls ?? [{ ok: true, data: { text: 'ok' } }])];
  const approvals = {
    check: async (i: { toolName: string; toolInput: Record<string, unknown> }) => {
      asked.push(i);
      return opts.allowByException ? { allow: true } : { allow: false, approvalId: `a${asked.length}` };
    },
    waitForVerdict: async () => ({ status: verdicts.shift() ?? 'approved' }),
  };
  const bridge = { call: async (_t: string, tool: string, args: Record<string, unknown>) => (sent.push({ tool, args }), calls.shift() ?? { ok: true, data: {} }) };
  const svc = new BrowserMcpService(bridge as never, { approvalsApiUrl: 'http://localhost:3011' } as never, { task: { findUnique: async () => ({ createdById: 'u1' }) } } as never, { get: () => approvals } as never, { list: () => [] } as never);
  const reg = svc.register('t1');
  const run = (tool: string, args: Record<string, unknown>, o?: { url?: string; why?: string }) => (svc as unknown as { run: (c: object, t: string, a: object, o?: object) => Promise<unknown> }).run({ taskId: 't1', exp: Date.now() + 1e6 }, tool, args, o);
  return { svc, reg, asked, sent, run };
}

describe('BrowserMcpService.run', () => {
  it('asks the person once per site and task, then remembers', async () => {
    const m = make();
    await m.run('open', {}, { url: 'https://example.com/a', why: 'look up a price' });
    await m.run('navigate', { tabId: 3 }, { url: 'https://example.com/b' });
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]).toMatchObject({ toolName: BROWSER_GRANT_TOOL, toolInput: { host: 'example.com', level: 'read', network: 'internet', why: 'look up a price' } });
    expect(m.sent.map((s) => s.tool)).toEqual(['open', 'navigate']);
    // the extension is told which hosts it may read, and the server's own addresses it must never touch
    expect(m.sent[1]!.args).toMatchObject({ allowHosts: ['example.com'], url: 'https://example.com/b' });
    expect((m.sent[1]!.args.ownOrigins as string[])).toContain('http://localhost:3088');
  });
  it('a standing exception («always») means no card at all', async () => {
    const m = make({ allowByException: true });
    await m.run('open', {}, { url: 'https://example.com' });
    expect(m.sent).toHaveLength(1);
  });
  it('a refusal stops the command and nothing is sent', async () => {
    const m = make({ verdicts: ['denied'] });
    await expect(m.run('open', {}, { url: 'https://example.com' })).rejects.toThrow(/did not allow/);
    expect(m.sent).toHaveLength(0);
  });
  it('sites that are never allowed do not even reach a card; a local-network address says so', async () => {
    const m = make();
    for (const u of ['https://paypal.com/x', 'https://mail.google.com', 'http://localhost:3088/settings', 'http://169.254.169.254/x', 'javascript:alert(1)', 'file:///etc/passwd']) {
      await expect(m.run('open', {}, { url: u }), u).rejects.toThrow();
    }
    expect(m.asked).toHaveLength(0);
    expect(m.sent).toHaveLength(0);
    await m.run('open', {}, { url: 'http://192.168.1.10:8080/' });
    expect(m.asked[0]!.toolInput).toMatchObject({ host: '192.168.1.10:8080', network: 'local network' });
  });
  it('a tab that turned out to be on another site asks for that site and retries once', async () => {
    const m = make({ calls: [{ ok: false, needsGrant: 'other.example.org', error: 'host' }, { ok: true, data: { text: 'ok' } }] });
    // the first grant (example.com) is implicit through an earlier open
    await m.run('open', {}, { url: 'https://example.com' }).catch(() => undefined);
    const m2 = make({ calls: [{ ok: false, needsGrant: 'other.example.org', error: 'host' }, { ok: true, data: { text: 'ok' } }] });
    const out = await m2.run('snapshot', { tabId: 1 });
    expect(out).toEqual({ text: 'ok' });
    expect(m2.asked[0]!.toolInput.host).toBe('other.example.org');
    expect(m2.sent).toHaveLength(2);
    expect((m2.sent[1]!.args.allowHosts as string[])).toEqual(['other.example.org']);
    // and a redirect to a never-allowed site is refused outright
    const m3 = make({ calls: [{ ok: false, needsGrant: 'login.microsoftonline.com', error: 'host' }] });
    await expect(m3.run('snapshot', { tabId: 1 })).rejects.toThrow(/Not allowed/);
    expect(m3.asked).toHaveLength(0);
  });
  it('each run gets its own token, and only a live token names a task', () => {
    const m = make();
    const other = m.svc.register('t2');
    expect(other.token).not.toBe(m.reg.token);
    const ctxOf = (h?: string) => (m.svc as unknown as { ctxOf: (h?: string) => { taskId: string } | null }).ctxOf(h);
    expect(ctxOf(`Bearer ${m.reg.token}`)?.taskId).toBe('t1');
    expect(ctxOf(`Bearer ${other.token}`)?.taskId).toBe('t2');
    expect(ctxOf('Bearer nope')).toBeNull();
    expect(ctxOf(undefined)).toBeNull();
  });
});

describe('acting on a page (interact level, submit cards)', () => {
  it('opening for interaction asks once at the interact level; later clicks on that site need nothing more', async () => {
    const m = make();
    await m.run('open', {}, { url: 'https://shop.example.com', level: 'interact', why: 'order a part' });
    expect(m.asked).toHaveLength(1);
    expect(m.asked[0]!.toolInput).toMatchObject({ host: 'shop.example.com', level: 'interact' });
    await m.run('click', { tabId: 1, ref: 'e3' });
    expect(m.asked).toHaveLength(1);
    expect(m.sent[1]!.args.allow).toEqual({ read: ['shop.example.com'], interact: ['shop.example.com'] });
  });
  it('a read grant is not enough to click: the person is asked for the interact level, then the click is NOT lost', async () => {
    const m = make({ calls: [{ ok: true, data: { text: 'ok' } }, { ok: false, needsGrant: 'shop.example.com', level: 'interact', error: 'not granted' }, { ok: true, data: { text: 'clicked' } }] });
    await m.run('open', {}, { url: 'https://shop.example.com' }); // read
    const out = await m.run('click', { tabId: 1, ref: 'e3' });
    expect(out).toEqual({ text: 'clicked' });
    expect(m.asked.map((a) => a.toolInput.level)).toEqual(['read', 'interact']);
    expect(m.sent.map((s) => s.tool)).toEqual(['open', 'click', 'click']); // the refused click is repeated after the grant (it was not carried out)
  });
  it('a click that WAS carried out and landed on another site is not repeated: the new page is read instead', async () => {
    const m = make({ calls: [{ ok: false, needsGrant: 'pay.other.org', error: 'not granted', data: { tabId: 7, performed: true } }, { ok: true, data: { text: 'new page' } }] });
    const out = await m.run('click', { tabId: 7, ref: 'e1' });
    expect(out).toEqual({ text: 'new page' });
    expect(m.sent.map((s) => s.tool)).toEqual(['click', 'snapshot']);
    expect(m.sent[1]!.args).toMatchObject({ tabId: 7 });
  });
  it('a form that would be submitted waits for the person; yes → the same command again, confirmed; no → an error and nothing sent', async () => {
    const info = { label: 'Place order', host: 'shop.example.com', action: 'https://shop.example.com/checkout', fields: [{ label: 'Email', value: 'a@b.co' }] };
    const yes = make({ calls: [{ ok: false, needsSubmit: info, error: 'needs the person' }, { ok: true, data: { text: 'ordered' } }] });
    expect(await yes.run('click', { tabId: 1, ref: 'e9' })).toEqual({ text: 'ordered' });
    expect(yes.asked[0]).toMatchObject({ toolName: BROWSER_SUBMIT_TOOL, toolInput: { host: 'shop.example.com', label: 'Place order', fields: [{ label: 'Email', value: 'a@b.co' }] } });
    expect(yes.sent[0]!.args.confirmed).toBeUndefined();
    expect(yes.sent[1]!.args.confirmed).toBe(true);
    const no = make({ verdicts: ['denied'], calls: [{ ok: false, needsSubmit: info, error: 'needs the person' }] });
    await expect(no.run('click', { tabId: 1, ref: 'e9' })).rejects.toThrow(/did not allow pressing "Place order"/);
    expect(no.sent).toHaveLength(1); // the confirmed command was never sent
  });
  it('the agent cannot confirm a submit itself: `confirmed` is never taken from a tool argument', async () => {
    const m = make({ calls: [{ ok: false, needsSubmit: { label: 'Send', host: 'x.example.com', fields: [] }, error: 'needs the person' }], verdicts: ['denied'] });
    // even if the model slipped it in, the tool's own argument list does not carry it: the server sets it only after a yes
    await expect(m.run('click', { tabId: 1, ref: 'e1', confirmed: true } as never)).rejects.toThrow();
    expect(m.sent[0]!.args.confirmed).toBeUndefined(); // stripped before anything is sent
  });
});
