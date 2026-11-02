import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/** A tiny Socket.IO (Engine.IO v4) SERVER over a hand-made WebSocket, for the end-to-end test: handshake, auth check in the connect packet, pings, events both ways. */
export class MockSio {
  readonly received: { name: string; args: unknown[] }[] = [];
  readonly authSeen: unknown[] = [];
  private sockets = new Set<Socket>();

  constructor(
    server: Server,
    private readonly validToken: string,
  ) {
    server.on('upgrade', (req, socket: Socket) => {
      if (!req.url?.startsWith('/socket.io/')) return socket.destroy();
      const key = String(req.headers['sec-websocket-key']);
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => undefined);
      this.frame(socket, '0{"sid":"s1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
      let buf = Buffer.alloc(0);
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1]! & 0x7f;
          let off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          const masked = (buf[1]! & 0x80) !== 0;
          if (buf.length < off + (masked ? 4 : 0) + len) return;
          const mask = masked ? buf.subarray(off, off + 4) : null;
          const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len));
          if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
          const opcode = buf[0]! & 0x0f;
          buf = buf.subarray(off + (masked ? 4 : 0) + len);
          if (opcode === 8) return socket.end();
          if (opcode === 1) this.onText(socket, payload.toString('utf8'));
        }
      });
    });
  }

  private onText(socket: Socket, text: string): void {
    if (text.startsWith('40')) {
      const auth = text.length > 2 ? (JSON.parse(text.slice(2)) as { token?: string }) : {};
      this.authSeen.push(auth);
      if (auth.token === this.validToken) this.frame(socket, '40{"sid":"c1"}');
      else {
        this.frame(socket, '44{"message":"unauthorised"}');
        socket.end();
      }
    } else if (text.startsWith('42')) {
      const arr = JSON.parse(text.slice(2)) as [string, ...unknown[]];
      this.received.push({ name: arr[0], args: arr.slice(1) });
    }
  }

  private frame(socket: Socket, text: string): void {
    const body = Buffer.from(text);
    const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
    socket.write(Buffer.concat([head, body]));
  }

  /** A server event to every connected client. */
  push(name: string, payload: unknown): void {
    for (const s of this.sockets) this.frame(s, `42${JSON.stringify([name, payload])}`);
  }

  get clients(): number {
    return this.sockets.size;
  }

  close(): void {
    for (const s of this.sockets) s.destroy();
  }
}
