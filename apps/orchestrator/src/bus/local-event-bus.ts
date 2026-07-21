import { EventEmitter } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';
import type { BusEvent } from './agent-event-bus';

/**
 * The `minimal`/single-container profile's event bus (docs/plan-single-
 * container.md) — bound to the same `AgentEventBus` token as the Redis
 * pub/sub implementation (bus.module.ts), picked when there's no Redis in the
 * deployment at all. A single orchestrator process has no "other instances"
 * to fan out to, so a plain in-process EventEmitter is not a reduced version
 * of the Redis bus — it's the correct, sufficient implementation here (the
 * Redis hop existed ONLY for cross-instance delivery).
 */
@Injectable()
export class LocalEventBus {
  private readonly logger = new Logger(LocalEventBus.name);
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many sockets may subscribe; lift the default listener cap.
    this.emitter.setMaxListeners(0);
  }

  publish(event: BusEvent): void {
    this.emitter.emit('bus', event);
  }

  subscribe(handler: (event: BusEvent) => void): () => void {
    this.emitter.on('bus', handler);
    return () => this.emitter.off('bus', handler);
  }
}
