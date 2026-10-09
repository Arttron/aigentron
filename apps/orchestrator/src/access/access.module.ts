import { Global, Module } from '@nestjs/common';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { CloudflareAccessController } from './cloudflare-access.controller';
import { CloudflareAccessService } from './cloudflare-access.service';

@Global()
@Module({ controllers: [AccessController, CloudflareAccessController], providers: [AccessService, CloudflareAccessService], exports: [AccessService, CloudflareAccessService] })
export class AccessModule {}
