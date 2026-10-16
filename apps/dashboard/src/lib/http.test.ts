import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildQuery, errMsg, request, setActingHeaders, unwrap } from './http';

const res = (status: number, body: string, statusText = '') => new Response(body, { status, statusText });

describe('unwrap', () => {
  it('parses a 2xx JSON body', async () => {
    expect(await unwrap<{ a: number }>(res(200, '{"a":1}'))).toEqual({ a: 1 });
  });
  it('throws ApiError with the status and the server text', async () => {
    const err = await unwrap(res(409, 'queue is full', 'Conflict')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).detail).toBe('queue is full');
    expect((err as ApiError).message).toBe('409 Conflict — queue is full');
  });
  it('keeps a bare status when the body is empty', async () => {
    const err = (await unwrap(res(500, '', 'Internal Server Error')).catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe('500 Internal Server Error');
    expect(err.detail).toBe('');
  });
});

describe('errMsg', () => {
  it('gives the clean server text for an ApiError', () => {
    expect(errMsg(new ApiError(400, 'name is taken', 'Bad Request'))).toBe('name is taken');
  });
  it('falls back to the status line when the server said nothing', () => {
    expect(errMsg(new ApiError(502, '', 'Bad Gateway'))).toBe('502 Bad Gateway');
  });
  it('strips the legacy "<status> <text> — " prefix from plain Errors', () => {
    expect(errMsg(new Error('404 Not Found — no such task'))).toBe('no such task');
  });
  it('leaves other errors and non-errors alone', () => {
    expect(errMsg(new Error('File is too large'))).toBe('File is too large');
    expect(errMsg('boom')).toBe('boom');
  });
});

describe('buildQuery', () => {
  it('is empty without params', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery({ a: undefined, b: null })).toBe('');
  });
  it('encodes values and stringifies numbers, keeping empty strings', () => {
    expect(buildQuery({ path: 'a b/c', page: 2, empty: '' })).toBe('?path=a+b%2Fc&page=2&empty=');
  });
});

describe('request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setActingHeaders(() => ({}));
  });
  const stub = (r: Response) => {
    const f = vi.fn().mockResolvedValue(r);
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('GET: no-store, query string, abort signal, no body', async () => {
    const f = stub(res(200, '[]'));
    const ac = new AbortController();
    await request('GET', '/tasks', { query: { q: 'x' }, signal: ac.signal });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tasks?q=x');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', signal: ac.signal });
    expect(init.body).toBeUndefined();
  });
  it('JSON body gets the content-type', async () => {
    const f = stub(res(200, '{}'));
    await request('POST', '/tasks', { body: { prompt: 'p' } });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"prompt":"p"}');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(init.cache).toBeUndefined();
  });
  it('raw body is sent as is with the caller headers', async () => {
    const f = stub(res(200, '{}'));
    const blob = new Blob(['hi']);
    await request('PUT', '/workspace/file', { raw: blob, headers: { 'content-type': 'application/octet-stream' } });
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(blob);
    expect(init.headers).toMatchObject({ 'content-type': 'application/octet-stream' });
  });
  it('adds the acting-user header when one is registered', async () => {
    const f = stub(res(200, '{}'));
    setActingHeaders(() => ({ 'x-lds-user': 'u1' }));
    await request('POST', '/tasks/1/cancel');
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'x-lds-user': 'u1' });
  });
  it('rejects with ApiError on a non-2xx answer', async () => {
    stub(res(404, 'gone', 'Not Found'));
    await expect(request('GET', '/tasks/x')).rejects.toMatchObject({ status: 404, detail: 'gone' });
  });
});
