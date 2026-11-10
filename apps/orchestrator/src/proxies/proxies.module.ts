import { Module } from '@nestjs/common';
import { ProxiesController } from './proxies.controller';
import { ProxyGatewayService } from './proxy-gateway.service';

@Module({ controllers: [ProxiesController], providers: [ProxyGatewayService], exports: [ProxyGatewayService] })
export class ProxiesModule {}
