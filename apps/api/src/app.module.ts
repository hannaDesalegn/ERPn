import { Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Root module.
 *
 * Modules here are business boundaries, not folders. Contract section 15.7: a module never
 * reaches into another module's tables, it calls the owning module's service. Identity,
 * sales, purchasing, inventory and accounting each become a module as they are built.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule, AuthModule, HealthModule],
})
export class AppModule {}
