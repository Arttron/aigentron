import { Module } from '@nestjs/common';
import { AddonsController } from './addons.controller';
import { AddonsService } from './addons.service';
import { AddonsViewProxyService } from './addons-view-proxy.service';

/** Add-ons (docs/addons.md): descriptors + installer state, and the browser add-on's authenticated view proxy. */
@Module({
  controllers: [AddonsController],
  providers: [AddonsService, AddonsViewProxyService],
  exports: [AddonsService],
})
export class AddonsModule {}
