import { Module } from '@nestjs/common';
import { AgentExecutor } from './agent-executor';
import { RealAgentExecutor } from './real-agent-executor';

/**
 * Binds the AgentExecutor port to the real implementation that drives
 * @lds/agent-runner. (StubAgentExecutor remains in the tree for reference/tests.)
 */
@Module({
  providers: [{ provide: AgentExecutor, useClass: RealAgentExecutor }],
  exports: [AgentExecutor],
})
export class AgentModule {}
