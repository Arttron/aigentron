import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer } from 'ws';
import { AccessService } from '../access/access.service';
import { tokenFromRequest } from '../auth/auth-core';
import { LocalBridgeService } from './local-bridge.service';
import { LocalDevicesService } from './local-devices.service';

export const LOCAL_AGENT_WS_PATH = '/api/local-agent/ws';

/**
 * The WebSocket the local agents dial (`/api/local-agent/ws`, `Authorization: Bearer lag_…`). A plain WebSocket beside Socket.IO: the daemon is written in Go, where a
 * Socket.IO client is a poor fit. The token is checked at the upgrade; the domain allow-list applies as everywhere else.
 */
@Injectable()
export class LocalAgentGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LocalAgentGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  constructor(
    private readonly host: HttpAdapterHost,
    private readonly bridge: LocalBridgeService,
    private readonly devices: LocalDevicesService,
    private readonly access: AccessService,
  ) {}

  private readonly attached = new WeakSet<object>();

  onApplicationBootstrap(): void {
    const server = this.host.httpAdapter?.getHttpServer?.();
    if (server) this.attach(server);
  }

  /** Serve the upgrade on a listener. The API port at bootstrap, and every 80/443 listener the built-in web server opens (web/web-server.service.ts) — a tunnel or a proxy usually reaches the app there. */
  attach(server: { on: (e: 'upgrade', l: (req: IncomingMessage, socket: Duplex, head: Buffer) => void) => unknown }): void {
    if (this.attached.has(server)) return;
    this.attached.add(server);
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
  }

  onApplicationShutdown(): void {
    for (const c of this.wss.clients) c.close(1001, 'server shutting down');
    this.wss.close();
  }

  private reject(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let path = '';
    try {
      path = new URL(req.url ?? '', 'http://x').pathname.replace(/\/+$/, '');
    } catch {
      return;
    }
    if (path !== LOCAL_AGENT_WS_PATH) return; // not ours (Socket.IO and others handle their own paths)
    if (!this.access.allowsRequest(req.headers.host, req.socket.remoteAddress, req.headers)) return this.reject(socket, '421 Misdirected Request');
    const device = this.devices.verify(tokenFromRequest(req.headers));
    if (!device) return this.reject(socket, '401 Unauthorized');
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const h = this.bridge.attach({ send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) }, device);
      ws.on('message', (data, isBinary) => (isBinary ? ws.close(4400, 'text frames only') : h.message(data.toString())));
      ws.on('close', h.close);
      ws.on('error', (e) => this.logger.debug(`socket error: ${e.message}`));
    });
  }
}
