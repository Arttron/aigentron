import { describe, expect, it } from 'vitest';
import { findClaudeToken, findDeviceCode, findUrl, stripTerminal, tailForError } from './login-core';

const CLAUDE_OUT =
  '\x1b[2G\x1b[1mThis\x1b[7Gwill\x1b[22m\r\r\n\x1b[38;2;153;153;153mBrowser didn\'t open? Use the url below\x1b[39m\r\r\n\r\r\n' +
  '\x1b]8;id=1q7batb;https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz\x1b\\https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz\x1b]8;;\x1b\\\r\r\n' +
  '\x1b[1mPaste code here if prompted >\x1b[22m ';

describe('findUrl', () => {
  it('reads the target of a terminal hyperlink, once', () => {
    expect(findUrl(CLAUDE_OUT, /oauth\/authorize/)).toBe('https://claude.com/cai/oauth/authorize?code=true&client_id=abc&scope=user%3Ainference&state=xyz');
  });
  it('takes the first https url when nothing is preferred, and none when the preferred one is absent', () => {
    expect(findUrl('Open https://auth.openai.com/codex/device and enter the code.')).toBe('https://auth.openai.com/codex/device');
    expect(findUrl('see https://example.com/x', /authorize/)).toBeNull();
    expect(findUrl('nothing here')).toBeNull();
  });
});

describe('findDeviceCode', () => {
  it('finds a code in styled output', () => {
    expect(findDeviceCode('Enter this one-time code\n\n   \x1b[94mAB12-CD345\x1b[0m\n')).toBe('AB12-CD345');
    expect(findDeviceCode('no code')).toBeNull();
  });
});

describe('findClaudeToken', () => {
  it('finds a token on its own line and ignores the url and prose', () => {
    const tok = 'sk-ant-oat01-' + 'A'.repeat(60);
    expect(findClaudeToken(`Your token:\r\n${tok}\r\nStore it safely`)).toBe(tok);
    expect(findClaudeToken(CLAUDE_OUT)).toBeNull();
  });
});

describe('stripTerminal / tailForError', () => {
  it('removes escapes and never echoes a token', () => {
    expect(stripTerminal('\x1b[1mhi\x1b[22m\r\n')).toBe('hi\n\n');
    expect(tailForError(`oops failed\nsk-ant-oat01-${'B'.repeat(40)}\nlogin cancelled by user`)).toBe('oops failed · login cancelled by user');
  });
});

import { classifyLoginInput } from './login-core';

describe('classifyLoginInput', () => {
  it('passes a plain code to the CLI', () => {
    expect(classifyLoginInput('  abc123#def456 ')).toEqual({ kind: 'stdin', text: 'abc123#def456' });
    expect(classifyLoginInput('two words')).toMatchObject({ kind: 'invalid' });
    expect(classifyLoginInput('')).toMatchObject({ kind: 'invalid' });
  });
  it('turns a failed localhost callback into a request the server makes itself (loopback only)', () => {
    expect(classifyLoginInput('http://localhost:53295/callback?code=AbC&state=xy')).toEqual({ kind: 'callback', url: 'http://127.0.0.1:53295/callback?code=AbC&state=xy' });
    expect(classifyLoginInput('http://localhost:53295/callback?code=')).toMatchObject({ kind: 'invalid' });
    expect(classifyLoginInput('http://localhost:80/callback?code=x')).toMatchObject({ kind: 'invalid' });
    expect(classifyLoginInput('http://localhost:53295/admin?code=x')).toMatchObject({ kind: 'invalid' });
  });
  it('reads the code out of the hosted code page address', () => {
    expect(classifyLoginInput('https://platform.claude.com/oauth/code/callback?code=C1&state=S1')).toEqual({ kind: 'stdin', text: 'C1#S1' });
    expect(classifyLoginInput('https://example.com/x')).toMatchObject({ kind: 'invalid' });
  });
});
