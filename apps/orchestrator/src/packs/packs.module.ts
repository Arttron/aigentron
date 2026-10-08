import { Module } from '@nestjs/common';
import { AgentRegistryModule } from '../agent-registry/agent-registry.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { PacksController } from './packs.controller';
import { PacksService } from './packs.service';

@Module({ imports: [AgentRegistryModule, SchedulesModule], controllers: [PacksController], providers: [PacksService], exports: [PacksService] })
export class PacksModule {}
