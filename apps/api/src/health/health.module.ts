import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ReadinessController } from './readiness.controller.js';

@Module({
  controllers: [HealthController, ReadinessController],
})
export class HealthModule {}
