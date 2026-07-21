import { EventEmitter } from 'node:events';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type IORedis from 'ioredis';
import type {
  AgentLogEvent,
  AgentSessionStatus,
  ApprovalRequest,
  ApprovalStatus,
  Task,
  TaskStatus,
} from '@lds/shared';
import { REDIS_CONNECTION } from '../redis/redis.module';

/**
 * Shared pub/sub decoupling event producers (executor, tasks service,
 * approvals) from consumers (the WebSocket gateway, the approvals long-poll).
 *
 * Transport is **Redis Pub/Sub** so multiple orchestrator instances observe the
 * same stream: a publish from any instance fans out to every instance's local
 * subscribers (including the publisher's own — the message returns over the
 * subscription). Postgres remains the durable source of truth for the
 * transcript; this channel is live, fire-and-forget (no replay). The interface
 * is unchanged from the former in-process EventEmitter, so a future upgrade to
 * Redis Streams (for federation replay/consumer-groups) is a localized swap.
 */
export type BusEvent =
  | { type: 'agent-log'; payload: AgentLogEvent }
  | { type: 'task-status'; payload: { taskId: string; status: TaskStatus; ts: string } }
  | {
      type: 'agent-status';
      payload: { taskId: string; agentSessionId: string; status: AgentSessionStatus; ts: string };
    }
  | { type: 'task-upserted'; payload: { task: Task } }
  | { type: 'task-deleted'; payload: { taskId: string } }
  | { type: 'approval-created'; payload: { approval: ApprovalRequest } }
  | {
      type: 'approval-resolved';
      payload: { approvalId: string; taskId: string; status: ApprovalStatus; ts: string };
    };

/** Redis Pub/Sub channel all orchestrator instances share. */
const CHANNEL = 'lds:bus';
/** Local in-process fan-out topic (subscribers register here). */
const LOCAL = 'bus';

@Injectable()
export class AgentEventBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentEventBus.name);
  private readonly emitter = new EventEmitter();
  /** Dedicated connection in subscribe mode (a subscribed client can't publish). */
  private sub?: IORedis;

  constructor(@Inject(REDIS_CONNECTION) private readonly redis: IORedis) {
    // Many sockets may subscribe; lift the default listener cap.
    this.emitter.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    // A Redis connection in subscribe mode can't issue other commands, so the
    // subscriber must be a separate connection from the publisher.
    this.sub = this.redis.duplicate();
    this.sub.on('message', (channel: string, message: string) => {
      if (channel !== CHANNEL) return;
      try {
        this.emitter.emit(LOCAL, JSON.parse(message) as BusEvent);
      } catch (err) {
        this.logger.warn(`Dropped malformed bus message: ${(err as Error).message}`);
      }
    });
    // ioredis auto-resubscribes on reconnect, so this survives Redis blips.
    await this.sub.subscribe(CHANNEL);
    this.logger.log(`Subscribed to Redis channel "${CHANNEL}"`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sub) {
      try {
        await this.sub.quit();
      } catch {
        this.sub.disconnect();
      }
    }
  }

  /**
   * Publish to all instances. Fire-and-forget: the event is delivered locally
   * only when it returns over the subscription (single delivery path). A Redis
   * hiccup drops the live push but never the durable state (Postgres).
   */
  publish(event: BusEvent): void {
    this.redis.publish(CHANNEL, JSON.stringify(event)).catch((err: Error) => {
      this.logger.warn(`Failed to publish ${event.type}: ${err.message}`);
    });
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.emitter.on(LOCAL, handler);
    return () => this.emitter.off(LOCAL, handler);
  }
}
