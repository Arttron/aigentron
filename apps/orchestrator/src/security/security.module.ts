import { Module } from '@nestjs/common';
import { SecurityPostureService } from './security-posture.service';

@Module({ providers: [SecurityPostureService] })
export class SecurityModule {}
