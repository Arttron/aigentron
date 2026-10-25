import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, buildQuery, cleanErrorBody, errMsg, request, setActingHeaders, unwrap } from './http';

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

describe('an error page instead of an answer', () => {
  const cloudflare = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie"> <![endif]--><head><title>x | 520: Web server is returning an unknown error</title></head><body>…</body></html>';
  it('a proxy error page becomes one plain sentence', () => {
    for (const status of [502, 503, 504, 520, 522, 527]) {
      const m = cleanErrorBody(status, cloudflare);
      expect(m).toContain(`HTTP ${status}`);
      expect(m).toContain('restarting or busy');
      expect(m).not.toContain('<');
    }
  });
  it('another HTML page is named as such, plain text and JSON text stay as they are', () => {
    expect(cleanErrorBody(404, '<html><body>nope</body></html>')).toBe('The server answered with a web page instead of data (HTTP 404).');
    expect(cleanErrorBody(409, 'queue is full')).toBe('queue is full');
    expect(cleanErrorBody(400, '{"message":"bad"}')).toBe('{"message":"bad"}');
  });
  it('a very long text is cut, a JSON error body is not (its message must stay parseable)', () => {
    expect(cleanErrorBody(500, 'x'.repeat(2000)).length).toBe(601);
    const json = JSON.stringify({ statusCode: 400, message: ['field ' + 'y'.repeat(900)], error: 'Bad Request' });
    expect(cleanErrorBody(400, json)).toBe(json);
    expect(JSON.parse(cleanErrorBody(400, json)).statusCode).toBe(400);
  });
  it('unwrap and errMsg show the sentence, not the page', async () => {
    const err = await unwrap(res(520, cloudflare, '')).catch((e: unknown) => e);
    expect(errMsg(err)).toBe('The server is not reachable right now (HTTP 520) — it may be restarting or busy. Try again in a minute.');
  });
});
