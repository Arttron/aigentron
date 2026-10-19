import { Global, Module } from '@nestjs/common';
import { CliRuntimeService } from './cli-runtime.service';

/** On-demand install of agent-runtime CLIs (Codex). Codex and config modules are global. */
@Global()
@Module({ providers: [CliRuntimeService], exports: [CliRuntimeService] })
export class CliRuntimeModule {}
