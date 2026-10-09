import { Global, Module } from '@nestjs/common';
import { WebServerController } from './web-server.controller';
import { WebServerService } from './web-server.service';

@Global()
@Module({ controllers: [WebServerController], providers: [WebServerService], exports: [WebServerService] })
export class WebServerModule {}
