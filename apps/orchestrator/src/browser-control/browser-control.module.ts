import { Global, Module } from '@nestjs/common';
import { BrowserBridgeService } from './browser-bridge.service';
import { BrowserControlController } from './browser-control.controller';
import { BrowserMcpService } from './browser-mcp.service';

/** Global: the events gateway (the extension's sockets) and the agent executor (a token per run) both need these. */
@Global()
@Module({ controllers: [BrowserControlController], providers: [BrowserBridgeService, BrowserMcpService], exports: [BrowserBridgeService, BrowserMcpService] })
export class BrowserControlModule {}
