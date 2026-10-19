import { describe, expect, it, vi } from 'vitest';
import { LoginSession, type LoginChild, type LoginDriver } from './login-session';
import { findClaudeToken, findDeviceCode, findUrl } from './login-core';

function fakeChild() {
  let out: (c: string) => void = () => undefined;
  let exit: (code: number | null) => void = () => undefined;
  const written: string[] = [];
  let killed = false;
  const child: LoginChild = { onOutput: (cb) => (out = cb), onExit: (cb) => (exit = cb), write: (t) => written.push(t), kill: () => (killed = true) };
  return { child, emit: (s: string) => out(s), exit: (c: number | null) => exit(c), written, killed: () => killed };
}

const deviceDriver = (finish = vi.fn(async () => 'Signed in.')): LoginDriver => ({
  needsCode: false,
  finishOnToken: false,
  interpret: (o) => ({ url: findUrl(o) ?? undefined, userCode: findDeviceCode(o) ?? undefined }),
  finish,
});
const claudeDriver = (finish = vi.fn(async () => 'Token saved.')): LoginDriver => ({
  needsCode: true,
  finishOnToken: true,
  interpret: (o) => ({ url: findUrl(o, /oauth\/authorize/) ?? undefined, token: findClaudeToken(o) ?? undefined }),
  finish,
});
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('LoginSession — device code flow', () => {
  it('shows the link and the code, then finishes when the CLI exits 0', async () => {
    const f = fakeChild();
    const finish = vi.fn(async () => 'Signed in to ChatGPT.');
    const s = new LoginSession(deviceDriver(finish), () => f.child, async () => undefined);
    s.start();
    f.emit('Open https://auth.openai.com/codex/device\nCode: AB12-CD345\n');
    expect(s.view()).toMatchObject({ phase: 'awaiting_browser', url: 'https://auth.openai.com/codex/device', userCode: 'AB12-CD345', needsCode: false });
    f.exit(0);
    await tick();
    expect(s.view()).toMatchObject({ phase: 'done', message: 'Signed in to ChatGPT.' });
    expect(finish).toHaveBeenCalledOnce();
  });

  it('fails with the tail of the output when the CLI exits non-zero', async () => {
    const f = fakeChild();
    const s = new LoginSession(deviceDriver(), () => f.child, async () => undefined);
    s.start();
    f.emit('Open https://x.example/device\nerror: the code expired\n');
    f.exit(1);
    await tick();
    expect(s.view().phase).toBe('failed');
    expect(s.view().message).toContain('the code expired');
  });
});

describe('LoginSession — paste-the-code flow', () => {
  const URL_OUT = 'Use this url\n\x1b]8;;https://claude.com/cai/oauth/authorize?code=true&state=s\x1b\\link\x1b]8;;\x1b\\\nPaste code here >';

  it('asks for the code, forwards it to the CLI and stores the token it prints — without ever exposing it', async () => {
    const f = fakeChild();
    const finish = vi.fn(async () => 'Token saved.');
    const s = new LoginSession(claudeDriver(finish), () => f.child, async () => undefined);
    s.start();
    f.emit(URL_OUT);
    expect(s.view()).toMatchObject({ phase: 'awaiting_code', needsCode: true });
    await s.submit('abc#def');
    expect(f.written).toEqual(['abc#def\r']);
    const token = 'sk-ant-oat01-' + 'Z'.repeat(60);
    f.emit(`\nYour token:\n${token}\n`);
    await tick();
    expect(finish).toHaveBeenCalledWith({ token });
    expect(JSON.stringify(s.view())).not.toContain('sk-ant');
    expect(s.view().phase).toBe('done');
    expect(f.killed()).toBe(true);
  });

  it('makes the request itself for a failed localhost callback, and keeps waiting if it is refused', async () => {
    const f = fakeChild();
    const calls: string[] = [];
    const s = new LoginSession(claudeDriver(), () => f.child, async (u) => {
      calls.push(u);
      throw new Error('connection refused');
    });
    s.start();
    f.emit(URL_OUT);
    await expect(s.submit('http://localhost:53295/callback?code=AbC&state=s')).rejects.toThrow(/did not accept/);
    expect(calls).toEqual(['http://127.0.0.1:53295/callback?code=AbC&state=s']);
    expect(s.view().phase).toBe('awaiting_code');
  });

  it('refuses a code when it is not waiting for one, and an empty paste', async () => {
    const f = fakeChild();
    const s = new LoginSession(claudeDriver(), () => f.child, async () => undefined);
    s.start();
    await expect(s.submit('abc')).rejects.toThrow(/not waiting/);
    f.emit(URL_OUT);
    await expect(s.submit('   ')).rejects.toThrow(/Paste/);
  });

  it('cancel kills the process; a timeout fails the attempt', async () => {
    const f = fakeChild();
    const s = new LoginSession(claudeDriver(), () => f.child, async () => undefined);
    s.start();
    s.cancel();
    expect(s.view().phase).toBe('cancelled');
    expect(f.killed()).toBe(true);

    const g = fakeChild();
    const t = new LoginSession(claudeDriver(), () => g.child, async () => undefined, () => undefined, 5);
    t.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.view().phase).toBe('failed');
    expect(t.view().message).toContain('10 minutes');
  });
});
