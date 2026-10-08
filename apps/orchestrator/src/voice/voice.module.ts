import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

/** Global: the channel manager (Telegram voice) and the dashboard both use it. */
@Global()
@Module({ imports: [ProvidersModule], controllers: [VoiceController], providers: [VoiceService], exports: [VoiceService] })
export class VoiceModule {}
