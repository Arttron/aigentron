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
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.bus.subscribe((event) => this.dispatch(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  /** Sockets whose window is currently focused (to decrement on disconnect). */
  private readonly focused = new Set<string>();

  handleConnection(client: Socket): void {
    void client.join(ROOM.global);
    this.presence.connect();
  }

  handleDisconnect(client: Socket): void {
    this.presence.disconnect();
    if (this.focused.delete(client.id)) this.presence.blur();
  }

  @SubscribeMessage(CLIENT_EVENT.focus)
  onFocus(@ConnectedSocket() client: Socket): void {
    if (!this.focused.has(client.id)) {
      this.focused.add(client.id);
      this.presence.focus();
    }
  }

  @SubscribeMessage(CLIENT_EVENT.blur)
  onBlur(@ConnectedSocket() client: Socket): void {
    if (this.focused.delete(client.id)) this.presence.blur();
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
    }
  }
}
