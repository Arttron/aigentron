import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { SessionsService } from './sessions.service';
import { ExtensionDevicesService } from './extension-devices.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionsService, ExtensionDevicesService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService, SessionsService, ExtensionDevicesService],
})
export class AuthModule {}
