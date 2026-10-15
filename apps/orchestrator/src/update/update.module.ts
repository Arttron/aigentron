import { Global, Module } from '@nestjs/common';
import { BootReconcileService } from './boot-reconcile.service';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';

@Global()
@Module({ controllers: [UpdateController], providers: [UpdateService, BootReconcileService], exports: [UpdateService] })
export class UpdateModule {}
