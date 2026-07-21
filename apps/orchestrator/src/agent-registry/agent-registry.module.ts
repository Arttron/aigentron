import { Global, Module } from '@nestjs/common';
import { AgentRegistryController } from './agent-registry.controller';
import { AgentRegistryService } from './agent-registry.service';
import { SkillsLearnedService } from './skills-learned.service';

/** Global so the tasks service and executor can resolve agent definitions. */
@Global()
@Module({
  controllers: [AgentRegistryController],
  providers: [AgentRegistryService, SkillsLearnedService],
  exports: [AgentRegistryService, SkillsLearnedService],
})
export class AgentRegistryModule {}
