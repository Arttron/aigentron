import { Module } from '@nestjs/common';
import { AgentExecutor } from './agent-executor';
import { RealAgentExecutor } from './real-agent-executor';
import { ResearchModule } from '../research/research.module';

/**
 * Binds the AgentExecutor port to the real implementation that drives
 * @lds/agent-runner. (StubAgentExecutor remains in the tree for reference/tests.)
 */
@Module({
  imports: [ResearchModule], // the executor hands each run a bearer for the built-in research MCP
  providers: [{ provide: AgentExecutor, useClass: RealAgentExecutor }],
  exports: [AgentExecutor],
})
export class AgentModule {}
