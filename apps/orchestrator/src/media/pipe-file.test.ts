import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { pipeFile } from './pipe-file';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pipe-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function fakeRes() {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const state = { status: 0, ended: false };
  const res = Object.assign(out, {
    headersSent: false,
    status(code: number) {
      state.status = code;
      return res;
    },
    type() {
      return res;
    },
  });
  const done = new Promise<void>((resolve) => out.on('finish', () => ((state.ended = true), resolve())));
  return { res: res as unknown as Response, state, body: () => Buffer.concat(chunks).toString(), done };
}

describe('pipeFile', () => {
  it('streams a file', async () => {
    await writeFile(join(dir, 'a.txt'), 'hello');
    const r = fakeRes();
    pipeFile(r.res, join(dir, 'a.txt'));
    await r.done;
    expect(r.body()).toBe('hello');
  });

  it('answers 404 instead of throwing when the path is a directory or missing (it used to crash the server)', async () => {
    for (const p of [dir, join(dir, 'missing.txt')]) {
      const r = fakeRes();
      expect(() => pipeFile(r.res, p)).not.toThrow();
      await r.done;
      expect(r.state.status).toBe(404);
    }
  });

  it('honours a byte range', async () => {
    await writeFile(join(dir, 'r.txt'), '0123456789');
    const r = fakeRes();
    pipeFile(r.res, join(dir, 'r.txt'), { start: 2, end: 4 });
    await r.done;
    expect(r.body()).toBe('234');
  });
});
