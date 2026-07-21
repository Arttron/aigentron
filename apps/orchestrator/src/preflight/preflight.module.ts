import { Module } from '@nestjs/common';
import { PreflightService } from './preflight.service';

@Module({ providers: [PreflightService] })
export class PreflightModule {}
