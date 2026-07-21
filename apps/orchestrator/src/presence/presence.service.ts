import { Global, Injectable, Module } from '@nestjs/common';

/**
 * Tracks how many dashboard clients are connected over Socket.IO, so other
 * services can tell whether anyone is watching the UI right now (e.g. to decide
 * whether an approval must be escalated to an external channel).
 */
@Injectable()
export class PresenceService {
  private online = 0;
  private focused = 0;

  connect(): void {
    this.online += 1;
  }

  disconnect(): void {
    this.online = Math.max(0, this.online - 1);
  }

  focus(): void {
    this.focused += 1;
  }

  blur(): void {
    this.focused = Math.max(0, this.focused - 1);
  }

  count(): number {
    return this.online;
  }

  anyoneOnline(): boolean {
    return this.online > 0;
  }

  /** True when at least one dashboard window is focused (actively watched). */
  anyoneFocused(): boolean {
    return this.focused > 0;
  }
}

@Global()
@Module({
  providers: [PresenceService],
  exports: [PresenceService],
})
export class PresenceModule {}
