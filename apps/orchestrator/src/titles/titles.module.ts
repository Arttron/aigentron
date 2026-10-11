import { Global, Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { SettingsModule } from '../settings/settings.module';
import { TranslateController } from './translate.controller';
import { TitlesController } from './titles.controller';
import { TitlesService } from './titles.service';

@Global()
@Module({ imports: [ProvidersModule, SettingsModule], controllers: [TitlesController, TranslateController], providers: [TitlesService], exports: [TitlesService] })
export class TitlesModule {}
