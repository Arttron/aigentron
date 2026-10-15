import { Module } from '@nestjs/common';
import { AgentExecutor } from './agent-executor';
import { RealAgentExecutor } from './real-agent-executor';
import { AgentUserService } from './agent-user.service';
import { ResearchModule } from '../research/research.module';

/**
 * Binds the AgentExecutor port to the real implementation that drives
 * @lds/agent-runner. (StubAgentExecutor remains in the tree for reference/tests.)
 * AgentUserService: the separate OS user agents run as (S-01, opt-in by env).
 */
@Module({
  imports: [ResearchModule], // the executor hands each run a bearer for the built-in research MCP
  providers: [AgentUserService, { provide: AgentExecutor, useClass: RealAgentExecutor }],
  exports: [AgentExecutor],
})
export class AgentModule {}
