import { Module } from '@nestjs/common';
import { ProviderLoginController } from './provider-login.controller';
import { ProviderLoginService } from './provider-login.service';

/** Providers and Codex modules are global. */
@Module({ controllers: [ProviderLoginController], providers: [ProviderLoginService] })
export class ProviderLoginModule {}
