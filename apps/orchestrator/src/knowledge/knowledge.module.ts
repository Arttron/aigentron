import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { ResourcesModule } from '../resources/resources.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';

@Global()
@Module({
  imports: [ProvidersModule, ResourcesModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
