import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { MessageBody, ConnectedSocket } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { CLIENT_EVENT, ROOM, SERVER_EVENT } from '@lds/shared';
import { AgentEventBus, type BusEvent } from '../bus/agent-event-bus';
import { PresenceService } from '../presence/presence.service';
import { resolveCorsOrigin } from '../config/cors';
import { AuthService } from '../auth/auth.service';
import { ExtensionDevicesService } from '../auth/extension-devices.service';
import { BrowserBridgeService } from '../browser-control/browser-bridge.service';
import { CloudflareAccessService } from '../access/cloudflare-access.service';
import { AccessService } from '../access/access.service';

/**
 * Bridges the in-process event bus to connected dashboard clients over
 * Socket.IO. Clients join the `global` feed automatically and may subscribe to
 * per-task rooms for live logs.
 */
@WebSocketGateway({ cors: { origin: resolveCorsOrigin(), credentials: true } })
export class EventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(EventsGateway.name);
  private unsubscribe?: () => void;

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly bus: AgentEventBus,
    private readonly presence: PresenceService,
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly cloudflare: CloudflareAccessService,
    private readonly devices: ExtensionDevicesService,
    private readonly bridge: BrowserBridgeService,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((event) => this.dispatch(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Sockets whose window is currently focused (to decrement on disconnect). */
  private readonly focused = new Set<string>();

  async handleConnection(client: Socket): Promise<void> {
    // A domain that is not allowed gets no live feed either (the HTTP middleware does not see WebSocket upgrades).
    // Live task output is private: with a password set, only a signed-in browser may listen.
    if (!this.access.allowsRequest(client.handshake.headers.host, client.handshake.address, client.handshake.headers)) {
      client.data.rejected = true;
      client.disconnect(true);
      return;
    }
    // Cloudflare Access (if on): a socket opened under a real domain needs Access's token too.
    if (this.cloudflare.required(client.handshake.headers.host) && !(await this.cloudflare.check(client.handshake.headers)).ok) {
      client.data.rejected = true;
      client.disconnect(true);
      return;
    }
    // a browser extension identifies itself with its device token in the connect packet (a socket has no headers to set from an extension)
    const deviceToken = (client.handshake.auth as { token?: unknown } | undefined)?.token;
    const device = typeof deviceToken === 'string' ? this.devices.verify(deviceToken, (client.handshake.auth as { version?: unknown } | undefined)?.version) : null;
    const extension = device !== null;
    if (!extension && !this.auth.isAuthenticated(client.handshake.headers)) {
      client.data.rejected = true;
      client.disconnect(true);
      return;
    }
    void client.join(ROOM.global);
    if (device) this.bridge.attach(client, device.id, device.userId); // commands for the browser (browser control) go to this socket
    this.presence.connect();
  }

  handleDisconnect(client: Socket): void {
    if (client.data.rejected) return; // never counted as present
    this.presence.disconnect();
    this.bridge.detach(client.id);
    if (this.focused.delete(client.id)) this.presence.blur();
  }

  @SubscribeMessage(CLIENT_EVENT.focus)
  onFocus(@ConnectedSocket() client: Socket): void {
    this.bridge.setFront(client.id, true);
    if (!this.focused.has(client.id)) {
      this.focused.add(client.id);
      this.presence.focus();
    }
  }

  @SubscribeMessage(CLIENT_EVENT.blur)
  onBlur(@ConnectedSocket() client: Socket): void {
    this.bridge.setFront(client.id, false);
    if (this.focused.delete(client.id)) this.presence.blur();
  }

  /** The browser extension's answer to a browser-control command. */
  @SubscribeMessage(CLIENT_EVENT.extResult)
  onExtResult(@ConnectedSocket() client: Socket, @MessageBody() body: unknown): void {
    if (body && typeof body === 'object') this.bridge.onResult(client.id, body as never);
  }

  /** The person allowed agents to use the browser again. */
  @SubscribeMessage(CLIENT_EVENT.extAllow)
  onExtAllow(@ConnectedSocket() client: Socket): void {
    this.bridge.onAllow(client.id);
  }

  /** The person pressed Stop in the extension. */
  @SubscribeMessage(CLIENT_EVENT.extStop)
  onExtStop(@ConnectedSocket() client: Socket): void {
    this.bridge.onStop(client.id);
  }

  @SubscribeMessage(CLIENT_EVENT.subscribeTask)
  subscribeTask(@ConnectedSocket() client: Socket, @MessageBody() taskId: string): void {
    if (typeof taskId === 'string') void client.join(ROOM.task(taskId));
  }

  @SubscribeMessage(CLIENT_EVENT.unsubscribeTask)
  unsubscribeTask(@ConnectedSocket() client: Socket, @MessageBody() taskId: string): void {
    if (typeof taskId === 'string') void client.leave(ROOM.task(taskId));
  }

  /** Translate a bus event into the right Socket.IO room emit(s). */
  private dispatch(event: BusEvent): void {
    if (!this.server) return;
    switch (event.type) {
      case 'agent-log':
        this.server.to(ROOM.task(event.payload.taskId)).emit(SERVER_EVENT.agentLog, event.payload);
        break;
      case 'agent-status':
        this.server
          .to(ROOM.task(event.payload.taskId))
          .emit(SERVER_EVENT.agentStatus, event.payload);
        break;
      case 'task-status':
        this.server.to(ROOM.global).emit(SERVER_EVENT.taskStatus, event.payload);
        this.server.to(ROOM.task(event.payload.taskId)).emit(SERVER_EVENT.taskStatus, event.payload);
        break;
      case 'task-upserted':
        this.server.to(ROOM.global).emit(SERVER_EVENT.taskUpserted, event.payload);
        break;
      case 'task-deleted':
        this.server.to(ROOM.global).emit(SERVER_EVENT.taskDeleted, event.payload);
        this.server.to(ROOM.task(event.payload.taskId)).emit(SERVER_EVENT.taskDeleted, event.payload);
        break;
      case 'approval-created':
        this.server.to(ROOM.global).emit(SERVER_EVENT.approvalCreated, event.payload);
        this.server
          .to(ROOM.task(event.payload.approval.taskId))
          .emit(SERVER_EVENT.approvalCreated, event.payload);
        break;
      case 'approval-resolved':
        this.server.to(ROOM.global).emit(SERVER_EVENT.approvalResolved, event.payload);
        this.server
          .to(ROOM.task(event.payload.taskId))
          .emit(SERVER_EVENT.approvalResolved, event.payload);
        break;
      case 'question-created':
        this.server.to(ROOM.global).emit(SERVER_EVENT.questionCreated, event.payload);
        this.server.to(ROOM.task(event.payload.question.taskId)).emit(SERVER_EVENT.questionCreated, event.payload);
        break;
      case 'question-resolved':
        this.server.to(ROOM.global).emit(SERVER_EVENT.questionResolved, event.payload);
        this.server.to(ROOM.task(event.payload.question.taskId)).emit(SERVER_EVENT.questionResolved, event.payload);
        break;
      case 'followup-queue':
        this.server.to(ROOM.task(event.payload.taskId)).emit(SERVER_EVENT.followUpQueue, event.payload);
        break;
    }
  }
}
