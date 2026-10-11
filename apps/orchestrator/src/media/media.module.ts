import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { VideoService } from './video.service';
import { VisionService } from './vision.service';

@Global()
@Module({ imports: [ProvidersModule], controllers: [MediaController], providers: [VisionService, VideoService, MediaService], exports: [VisionService, VideoService, MediaService] })
export class MediaModule {}
