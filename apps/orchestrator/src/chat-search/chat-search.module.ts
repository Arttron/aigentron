import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ChatSearchController } from './chat-search.controller';
import { ChatSearchService } from './chat-search.service';

@Module({ imports: [ProjectsModule], controllers: [ChatSearchController], providers: [ChatSearchService], exports: [ChatSearchService] })
export class ChatSearchModule {}
