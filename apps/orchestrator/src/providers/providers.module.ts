import { Global, Module } from '@nestjs/common';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';
import { LitellmModule } from '../litellm/litellm.module';

/** Global so the executor can resolve a provider by name at spawn time. */
@Global()
@Module({
  imports: [LitellmModule],
  controllers: [ProvidersController],
  providers: [ProvidersService],
  exports: [ProvidersService],
})
export class ProvidersModule {}
