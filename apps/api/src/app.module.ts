import { Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { AppConfigModule } from './config/config.module.js';
import { AdministrationModule } from './administration/administration.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthorizationModule } from './authorization/authorization.module.js';
import { CompaniesModule } from './companies/companies.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { SalesModule } from './sales/sales.module.js';
import { AccessGuard } from './http/access.guard.js';
import { CsrfGuard } from './http/csrf.guard.js';
import { RouteDeclarationAudit } from './http/route-declarations.js';

/**
 * Root module.
 *
 * Modules here are business boundaries, not folders. Contract section 15.7: a module never
 * reaches into another module's tables, it calls the owning module's service. Identity,
 * sales, purchasing, inventory and accounting each become a module as they are built.
 */
@Module({
  // DiscoveryModule is what lets the startup audit walk the controllers Nest registered, so the
  // check reads the same metadata the guard reads rather than a parallel list.
  imports: [
    AppConfigModule,
    DiscoveryModule,
    DatabaseModule,
    AuthModule,
    AuthorizationModule,
    IdentityModule,
    AdministrationModule,
    CompaniesModule,
    SalesModule,
    HealthModule,
  ],
  providers: [
    // Both global, per section 6.2. A guard applied per controller is a guard that will be
    // forgotten on the two hundredth route, and the shape where forgetting produces a refusal
    // rather than an opening is the only one worth having.
    //
    // Order matters and is the order of the questions. Did this come from our own page, section
    // 14.4. Is there a live session, section 5. May this person do this here, section 6. A
    // forged request is turned away before anything touches the database.
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    RouteDeclarationAudit,
  ],
})
export class AppModule {}
