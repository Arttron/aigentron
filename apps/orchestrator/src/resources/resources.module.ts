import { Global, Module } from '@nestjs/common';
import { ResourcesController } from './resources.controller';
import { ResourcesService } from './resources.service';

/** Global: the agent executor, the admin tools and the packs all read the same library. */
@Global()
@Module({ controllers: [ResourcesController], providers: [ResourcesService], exports: [ResourcesService] })
export class ResourcesModule {}
