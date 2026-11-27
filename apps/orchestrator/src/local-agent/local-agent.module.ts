import { Module } from '@nestjs/common';
import { LocalAgentController } from './local-agent.controller';
import { LocalAgentGateway } from './local-agent.gateway';
import { LocalAgentPackageService } from './local-agent-package.service';
import { LocalBindingsService } from './local-bindings.service';
import { LocalBridgeService } from './local-bridge.service';
import { LocalDevicesService } from './local-devices.service';
import { LocalLlmAdminController } from './local-llm-admin.controller';
import { LocalLlmController } from './local-llm.controller';
import { LocalLlmService } from './local-llm.service';
import { LocalProjectsController } from './local-projects.controller';
import { LocalOsMcpController } from './local-os-mcp.controller';
import { LocalOsMcpService } from './local-os-mcp.service';
import { LocalRulesService } from './local-rules.service';

@Module({
  controllers: [LocalAgentController, LocalOsMcpController, LocalLlmController, LocalLlmAdminController, LocalProjectsController],
  providers: [LocalDevicesService, LocalBridgeService, LocalAgentPackageService, LocalAgentGateway, LocalRulesService, LocalBindingsService, LocalOsMcpService, LocalLlmService],
  exports: [LocalBridgeService, LocalDevicesService, LocalBindingsService, LocalOsMcpService, LocalLlmService],
})
export class LocalAgentModule {}
