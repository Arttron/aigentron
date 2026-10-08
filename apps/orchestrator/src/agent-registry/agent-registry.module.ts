import { Global, Module } from '@nestjs/common';
import { AgentRegistryController } from './agent-registry.controller';
import { AgentRegistryService } from './agent-registry.service';
import { SkillsLearnedService } from './skills-learned.service';
import { AgentFilesSyncService } from './agent-files-sync.service';
import { AgentCatalogService } from './agent-catalog.service';
import { AgentProposalsService } from './agent-proposals.service';
import { AdminAgentSeedService } from './admin-agent-seed.service';
import { PlatformAdminService } from './platform-admin.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuditController } from './admin-audit.controller';

/** Global so the tasks service and executor can resolve agent definitions. */
@Global()
@Module({
  controllers: [AgentRegistryController, AdminAuditController],
  providers: [
    AgentRegistryService,
    SkillsLearnedService,
    AgentFilesSyncService,
    AgentCatalogService,
    AgentProposalsService,
    AdminAgentSeedService,
    PlatformAdminService,
    AdminAuditService,
  ],
  exports: [AgentRegistryService, SkillsLearnedService, AgentCatalogService, AgentProposalsService, PlatformAdminService, AdminAuditService],
})
export class AgentRegistryModule {}
