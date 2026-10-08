import { Global, Module } from '@nestjs/common';
import { CodexService } from './codex.service';

@Global()
@Module({ providers: [CodexService], exports: [CodexService] })
export class CodexModule {}
