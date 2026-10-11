import { Global, Module } from '@nestjs/common';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';

@Global()
@Module({ controllers: [UpdateController], providers: [UpdateService], exports: [UpdateService] })
export class UpdateModule {}
