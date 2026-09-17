/**
 * The demo seed, as a module the seed entry point boots without an HTTP server.
 *
 * It imports the modules that own what it reuses rather than redeclaring their providers, so the
 * company provisioning, role assignment and password hashing it runs are the application's own
 * instances with the application's own configuration.
 *
 * Not imported by `AppModule`. The running API has no business being able to create demo
 * accounts, and nothing reachable over HTTP depends on this module.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CompaniesModule } from '../companies/companies.module.js';
import { AppConfigModule } from '../config/config.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DemoSeedService } from './demo-seed.service.js';

@Module({
  imports: [AppConfigModule, DatabaseModule, AuthModule, AuthorizationModule, CompaniesModule],
  providers: [DemoSeedService],
  exports: [DemoSeedService],
})
export class DemoSeedModule {}
