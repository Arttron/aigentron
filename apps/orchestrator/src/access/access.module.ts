import { Global, Module } from '@nestjs/common';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';

@Global()
@Module({ controllers: [AccessController], providers: [AccessService], exports: [AccessService] })
export class AccessModule {}
