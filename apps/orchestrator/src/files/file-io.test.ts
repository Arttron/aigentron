import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';
import { contentDisposition, pipeFile, readBodyLimited, saveStream, saveUpload, serveFile } from './file-io';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fio-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const tooBig = (l: number) => new Error(`over ${l}`);

function fakeRes() {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const headers: Record<string, string> = {};
  const state = { status: 200, ended: false };
  const res = Object.assign(out, {
    headersSent: false,
    status(code: number) {
      state.status = code;
      return res;
    },
    type() {
      return res;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
      return res;
    },
  });
  const done = new Promise<void>((resolve) => out.on('finish', () => ((state.ended = true), resolve())));
  return { res: res as unknown as Response, state, headers, body: () => Buffer.concat(chunks).toString(), done };
}
const req = (range?: string) => ({ headers: range ? { range } : {} }) as unknown as Request;

describe('saveStream / saveUpload', () => {
  it('writes the stream, returns the size, leaves no temp file', async () => {
    const n = await saveUpload(Readable.from([Buffer.from('hel'), Buffer.from('lo')]), join(dir, 'a.txt'), { limit: 10, tooBig });
    expect(n).toBe(5);
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('hello');
    expect(await readdir(dir)).toEqual(['a.txt']);
  });
  it('stops at the limit and removes the temp file', async () => {
    await expect(saveStream(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), join(dir, '.t.part'), { limit: 10, tooBig })).rejects.toThrow(/over 10/);
    expect(await readdir(dir)).toEqual([]);
  });
  it('a broken source leaves nothing; `check` can refuse too', async () => {
    const bad = new Readable({ read() { this.destroy(new Error('connection lost')); } });
    await expect(saveUpload(bad, join(dir, 'b.txt'), { limit: 10, tooBig })).rejects.toThrow(/connection lost/);
    await expect(saveUpload(Readable.from([Buffer.from('xyz')]), join(dir, 'c.txt'), { limit: 10, tooBig, check: (s) => { if (s > 2) throw new Error('quota'); } })).rejects.toThrow(/quota/);
    expect(await readdir(dir)).toEqual([]);
  });
  it('never writes over an existing temp file', async () => {
    await writeFile(join(dir, '.t.part'), 'old');
    await expect(saveStream(Readable.from([Buffer.from('x')]), join(dir, '.t.part'), { limit: 10, tooBig })).rejects.toThrow(/EEXIST/);
  });
  it('readBodyLimited collects small bodies and refuses big ones', async () => {
    expect((await readBodyLimited(Readable.from([Buffer.from('ab'), 'c']), 10, tooBig)).toString()).toBe('abc');
    await expect(readBodyLimited(Readable.from([Buffer.alloc(11)]), 10, tooBig)).rejects.toThrow(/over 10/);
  });
});

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

describe('serveFile', () => {
  it('a picture: inline, nosniff, ranges announced, whole file with its length', async () => {
    await writeFile(join(dir, 'p.png'), 'PNGDATA');
    const r = fakeRes();
    await serveFile(req(), r.res, { path: join(dir, 'p.png'), name: 'p.png' });
    await r.done;
    expect(r.headers).toMatchObject({ 'content-type': 'image/png', 'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes', 'content-length': '7', 'cache-control': 'private, max-age=300' });
    expect(r.headers['content-disposition']).toBeUndefined();
    expect(r.body()).toBe('PNGDATA');
  });
  it('a non-inline type downloads with an RFC 5987 name (non-ASCII kept, ASCII fallback present)', async () => {
    await writeFile(join(dir, 'd.docx'), 'x');
    const r = fakeRes();
    await serveFile(req(), r.res, { path: join(dir, 'd.docx'), name: 'кухня план.docx', cacheControl: 'private, no-cache' });
    await r.done;
    expect(r.headers['content-disposition']).toBe(`attachment; filename="_____ ____.docx"; filename*=UTF-8''${encodeURIComponent('кухня план.docx')}`);
    expect(r.headers['content-type']).toMatch(/wordprocessingml/);
    expect(r.headers['cache-control']).toBe('private, no-cache');
    expect(contentDisposition('attachment', 'a"b\\c.txt')).toBe(`attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`);
  });
  it('text is inline as text/plain; html / svg always download; `download` forces it for anything', async () => {
    await writeFile(join(dir, 'n.md'), '# hi');
    await writeFile(join(dir, 'p.svg'), '<svg onload=alert(1)>');
    let r = fakeRes();
    await serveFile(req(), r.res, { path: join(dir, 'n.md'), name: 'n.md' });
    await r.done;
    expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(r.headers['content-disposition']).toBeUndefined();
    r = fakeRes();
    await serveFile(req(), r.res, { path: join(dir, 'p.svg'), name: 'p.svg' });
    await r.done;
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="p.svg"/);
    r = fakeRes();
    await serveFile(req(), r.res, { path: join(dir, 'n.md'), name: 'n.md', download: true });
    await r.done;
    expect(r.headers['content-disposition']).toMatch(/^attachment/);
  });
  it('byte ranges: 206 with the slice, 416 when out of range, suffix ranges', async () => {
    await writeFile(join(dir, 'v.mp4'), '0123456789');
    let r = fakeRes();
    await serveFile(req('bytes=2-4'), r.res, { path: join(dir, 'v.mp4') });
    await r.done;
    expect(r.state.status).toBe(206);
    expect(r.headers).toMatchObject({ 'content-range': 'bytes 2-4/10', 'content-length': '3', 'content-type': 'video/mp4' });
    expect(r.body()).toBe('234');
    r = fakeRes();
    await serveFile(req('bytes=-3'), r.res, { path: join(dir, 'v.mp4') });
    await r.done;
    expect(r.body()).toBe('789');
    r = fakeRes();
    await serveFile(req('bytes=50-'), r.res, { path: join(dir, 'v.mp4') });
    await r.done;
    expect(r.state.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */10');
  });
  it('a folder, a missing file and a dotted name are 404 — never a crash', async () => {
    for (const p of [dir, join(dir, 'none.txt'), join(dir, '..')]) {
      const r = fakeRes();
      await serveFile(req(), r.res, { path: p });
      await r.done;
      expect(r.state.status, p).toBe(404);
    }
  });
});
