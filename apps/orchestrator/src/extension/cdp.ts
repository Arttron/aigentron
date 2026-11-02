import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Socket } from 'node:net';

/** A minimal Chrome DevTools Protocol client over a hand-made WebSocket (Node 20 has no global WebSocket) — enough to evaluate script in a page in the tests. */
export class Cdp {
  private id = 0;
  private buf = Buffer.alloc(0);
  private readonly waiting = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();

  private constructor(private readonly socket: Socket) {
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
  }

  static connect(wsUrl: string): Promise<Cdp> {
    const u = new URL(wsUrl);
    const key = randomBytes(16).toString('base64');
    return new Promise((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' } });
      req.on('upgrade', (res, socket, head) => {
        const want = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        if (res.headers['sec-websocket-accept'] !== want) return reject(new Error('bad websocket handshake'));
        const c = new Cdp(socket);
        if (head.length) {
          c.buf = Buffer.concat([c.buf, head]);
          c.drain();
        }
        resolve(c);
      });
      req.on('error', reject);
      req.end();
    });
  }

  private drain(): void {
    for (;;) {
      if (this.buf.length < 2) return;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const opcode = this.buf[0]! & 0x0f;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === 1) {
        const m = JSON.parse(payload.toString('utf8')) as { id?: number; result?: unknown; error?: { message: string } };
        if (m.id !== undefined) this.waiting.get(m.id)?.(m);
      }
    }
  }

  private send(method: string, params: object): Promise<{ result?: unknown; error?: { message: string } }> {
    const id = ++this.id;
    const body = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = randomBytes(4);
    const head = body.length < 126 ? Buffer.from([0x81, 0x80 | body.length]) : body.length < 65536 ? Buffer.from([0x81, 0x80 | 126, body.length >> 8, body.length & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(body.length), 2); return h; })();
    const masked = Buffer.from(body.map((b, i) => b ^ mask[i % 4]!));
    this.socket.write(Buffer.concat([head, mask, masked]));
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  /** Any protocol command; returns its `result` (throws on a protocol error). */
  async call<T = Record<string, unknown>>(method: string, params: object = {}): Promise<T> {
    const r = (await this.send(method, params)) as { result?: T; error?: { message: string } };
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return (r.result ?? {}) as T;
  }

  /** Evaluate an expression in the page (awaiting a promise) and return its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result?: { result?: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }; error?: { message: string } };
    if (r.error) throw new Error(r.error.message);
    const ex = r.result?.exceptionDetails;
    if (ex) throw new Error(ex.exception?.description ?? ex.text);
    return r.result?.result?.value as T;
  }

  close(): void {
    this.socket.destroy();
  }
}
