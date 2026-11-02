import { Module } from '@nestjs/common';
import { ExtensionController } from './extension.controller';
import { ExtensionService } from './extension.service';
import { ClipService } from './clip.service';
import { TasksModule } from '../tasks/tasks.module';

@Module({ imports: [TasksModule], controllers: [ExtensionController], providers: [ExtensionService, ClipService], exports: [ExtensionService] })
export class ExtensionModule {}
