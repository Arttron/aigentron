import { describe, expect, it } from 'vitest';
import { classifyPaste, fenceFor, insideFence, smartPaste, stripAnsi, toFencedBlock } from './paste-detect';

const kind = (s: string) => classifyPaste(s).kind;

describe('terminal output', () => {
  it('a shell session with prompts and output', () => {
    expect(classifyPaste('ubuntu@ip-172-31-65-12:~$ df -h /\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/root       6.8G  6.7G     0 100% /')).toMatchObject({ kind: 'terminal', lang: 'bash' });
    expect(classifyPaste('$ npm install\n$ npm run build')).toMatchObject({ kind: 'terminal' });
    expect(classifyPaste('PS C:\\Users\\me> Get-Process\nHandles  NPM(K)')).toMatchObject({ kind: 'terminal' });
  });
  it('a single command with a prompt, but not a bare line', () => {
    expect(kind('$ sudo systemctl restart aigentron')).toBe('terminal');
    expect(kind('sudo systemctl restart aigentron')).toBe('prose');
    expect(kind('how do I restart it?')).toBe('prose');
  });
  it('a block of commands without prompts', () => {
    expect(classifyPaste('cd /opt/aigentron\nsudo systemctl restart aigentron\njournalctl -u aigentron -n 50').kind).toBe('terminal');
  });
  it('logs: timestamps, levels, stack traces, npm errors', () => {
    expect(kind('Oct 19 20:33:34 ip-172 aigentron[7248]: [Nest] LOG [TaskWorkerService] finished\nOct 19 20:39:06 ip-172 aigentron[7248]: [Nest] LOG [TasksService] resuming lead')).toBe('log');
    expect(kind('2026-10-19T20:33:34Z INFO starting\n2026-10-19T20:33:35Z ERROR boom')).toBe('log');
    expect(kind('Error: ENOENT: no such file\n    at Object.openSync (node:fs:573:18)\n    at readFileSync (node:fs:452:35)')).toBe('log');
    expect(kind('Traceback (most recent call last):\n  File "app.py", line 3, in <module>\n    main()\nValueError: bad')).toBe('log');
    expect(kind('npm ERR! code ELIFECYCLE\nnpm ERR! errno 1')).toBe('log');
  });
  it('ANSI-coloured output is terminal output, and the colour codes are removed', () => {
    const coloured = '\x1b[32m✔\x1b[0m built\n\x1b[31m✖\x1b[0m failed';
    expect(kind(coloured)).toBe('log');
    expect(stripAnsi(coloured)).toBe('✔ built\n✖ failed');
    expect(toFencedBlock(coloured, 'text')).not.toContain('\x1b');
  });
  it('aligned table output (ps, df, ls -l)', () => {
    expect(kind('USER  PID  %CPU  %MEM\nroot    1   0.0   0.1\nubuntu 22   1.2   0.4')).toBe('log');
  });
});

describe('code', () => {
  it('TypeScript / JavaScript', () => {
    expect(classifyPaste('export interface User {\n  id: string;\n  name: string;\n}\n\nexport const greet = (u: User) => `hi ${u.name}`;')).toMatchObject({ kind: 'code', lang: 'ts' });
    expect(classifyPaste('const total = items.reduce((a, b) => a + b.price, 0);\nconsole.log(total);\nmodule.exports = { total };')).toMatchObject({ kind: 'code', lang: 'js' });
  });
  it('Python', () => {
    expect(classifyPaste('import os\n\ndef main(path: str) -> None:\n    for f in os.listdir(path):\n        print(f)\n')).toMatchObject({ kind: 'code', lang: 'py' });
  });
  it('shell script, SQL, HTML, Go, Rust', () => {
    expect(classifyPaste('#!/bin/bash\nset -e\nfor f in *.log; do\n  echo "$f"\ndone')).toMatchObject({ kind: 'code', lang: 'bash' });
    expect(classifyPaste('SELECT id, title\nFROM "Task"\nWHERE status = \'queued\'\nORDER BY "createdAt" DESC;')).toMatchObject({ kind: 'code', lang: 'sql' });
    expect(classifyPaste('<div class="card">\n  <span>Hello</span>\n</div>')).toMatchObject({ kind: 'code', lang: 'html' });
    expect(classifyPaste('package main\n\nfunc main() {\n\tx := 1\n\tprintln(x)\n}')).toMatchObject({ kind: 'code', lang: 'go' });
    expect(classifyPaste('fn main() {\n    let mut x = 1;\n    println!("{}", x);\n}')).toMatchObject({ kind: 'code', lang: 'rust' });
  });
  it('YAML needs several clean lines of it', () => {
    expect(classifyPaste('services:\n  web:\n    image: nginx\n    ports:\n      - "80:80"')).toMatchObject({ kind: 'code', lang: 'yaml' });
  });
  it('JSON and diffs', () => {
    expect(classifyPaste('{\n  "a": 1,\n  "b": [1, 2]\n}')).toMatchObject({ kind: 'json', lang: 'json' });
    expect(classifyPaste('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;')).toMatchObject({ kind: 'diff', lang: 'diff' });
  });
});

describe('prose stays prose', () => {
  it('sentences, lists, questions, Russian text, quotes', () => {
    for (const t of [
      'Привет! Посмотри, пожалуйста, почему задача зависла в очереди.\nЯ перезапускал сервер, но не помогло.',
      'First, check the disk.\nThen restart the service, and tell me what the log says.',
      '- one thing\n- another thing\n- a third thing',
      '1. open the page\n2. press the button\n3. read the message',
      'Hello world',
      'Why is the test failing? It passes on my machine.',
      '| a | b |\n|---|---|\n| 1 | 2 |',
      'https://github.com/Arttron/lowgrid.git\nhttps://github.com/Arttron/aigentron',
    ]) expect(kind(t), t).toBe('prose');
  });
  it('indented or comma-ended prose is not code', () => {
    expect(kind('    Dear team,\n    we shipped the release today,\n    and the notes are attached.')).toBe('prose');
  });
  it('empty, whitespace and already-fenced text are left alone', () => {
    expect(kind('')).toBe('prose');
    expect(kind('   \n  ')).toBe('prose');
    expect(kind('```ts\nconst a = 1;\n```')).toBe('prose');
  });
});

describe('fences and the edit', () => {
  it('the fence is longer than any backtick run inside', () => {
    expect(fenceFor('no ticks')).toBe('```');
    expect(fenceFor('has ``` inside')).toBe('````');
    expect(toFencedBlock('a ``` b\nc', 'text')).toBe('````text\na ``` b\nc\n````');
  });
  it('knows when the caret is inside an open block', () => {
    expect(insideFence('```ts\nconst a', 13)).toBe(true);
    expect(insideFence('```ts\nx\n```\nafter', 16)).toBe(false);
  });
  it('pastes into the middle of text as a separate block, caret after it', () => {
    const value = 'look at this: and then more';
    const e = smartPaste(value, 14, 14, '$ npm test\nFAIL src/a.test.ts')!;
    expect(e.kind).toBe('terminal');
    expect(e.value).toBe('look at this: \n\n```bash\n$ npm test\nFAIL src/a.test.ts\n```\n\nand then more');
    expect(e.value.slice(0, e.caret).endsWith('```\n\n')).toBe(true);
  });
  it('into an empty box: just the block and a newline to keep typing', () => {
    const e = smartPaste('', 0, 0, 'const a = 1;\nconst b = 2;\nconsole.log(a + b);')!;
    expect(e.value).toBe('```js\nconst a = 1;\nconst b = 2;\nconsole.log(a + b);\n```\n');
    expect(e.caret).toBe(e.value.length);
  });
  it('replaces the selection, and does nothing for prose or inside a block', () => {
    expect(smartPaste('old text here', 4, 8, 'plain sentence')).toBeNull();
    expect(smartPaste('```\nx\n', 7, 7, '$ ls\nfoo')).toBeNull();
    const e = smartPaste('see: SELECTED end', 5, 13, 'SELECT 1\nFROM t\nWHERE a = 1;')!;
    expect(e.value).toContain('```sql');
    expect(e.value).not.toContain('SELECTED');
  });
});
