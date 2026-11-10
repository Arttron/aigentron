import { Controller, Get, Query } from '@nestjs/common';
import { ChatSearchService } from './chat-search.service';
import { SearchChatsDto } from './search-chats.dto';
import { CurrentUser } from '../identity/current-user.decorator';
import type { UserRow } from '../users/users.service';

/** Search in the conversations of tasks (docs/chat-search.md). Readable by everyone who can read the task list. */
@Controller('search')
export class ChatSearchController {
  constructor(private readonly search: ChatSearchService) {}

  @Get('chats')
  chats(@Query() dto: SearchChatsDto, @CurrentUser() user: UserRow | undefined) {
    return this.search.search(dto, user?.id ?? null);
  }

  /** How much of the history is indexed (the page shows "building the index…" while it is not all). */
  @Get('chats/status')
  status() {
    return this.search.status();
  }
}
