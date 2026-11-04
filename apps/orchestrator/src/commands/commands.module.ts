import { Global, Module } from '@nestjs/common';
import { CommandPipelineService } from './command-pipeline.service';
import { CommandsController } from './commands.controller';

/** Global: the agent executor registers each run's folder and rules here. */
@Global()
@Module({ controllers: [CommandsController], providers: [CommandPipelineService], exports: [CommandPipelineService] })
export class CommandsModule {}
