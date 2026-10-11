import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { ImageOptimizer } from './image-optimizer.service';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { VideoService } from './video.service';
import { VisionService } from './vision.service';

@Global()
@Module({ imports: [ProvidersModule], controllers: [MediaController], providers: [ImageOptimizer, VisionService, VideoService, MediaService], exports: [ImageOptimizer, VisionService, VideoService, MediaService] })
export class MediaModule {}
