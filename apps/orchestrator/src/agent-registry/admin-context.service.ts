import { Injectable } from '@nestjs/common';
import type { PageRef } from './admin-context-core';

/**
 * Where the person is in the dashboard while they talk to the admin: the chat widget reports its route with each message,
 * the `current_context` tool reads it. In memory — it is a hint about the moment, not state.
 */
@Injectable()
export class AdminContextService {
  private readonly pages = new Map<string, PageRef & { at: number }>();

  set(adminTaskId: string, page: PageRef): void {
    this.pages.set(adminTaskId, { ...page, at: Date.now() });
    // Chats are few, but a long-running server should not keep every one forever.
    if (this.pages.size > 200) {
      const oldest = [...this.pages.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.pages.delete(oldest[0]);
    }
  }

  get(adminTaskId: string): (PageRef & { at: number }) | undefined {
    return this.pages.get(adminTaskId);
  }
}
