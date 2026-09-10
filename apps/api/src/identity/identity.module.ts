/**
 * Identity: who someone is, and which company they are working in.
 *
 * Section 15.7 makes a module a business boundary rather than a folder. This one owns the
 * session-to-context resolution and the company switch, and nothing else reaches into
 * memberships to answer those questions for itself.
 *
 * It does not own authorization. What a role permits, and the refusal of a request that lacks
 * it, is a separate module in a separate increment.
 */

import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { SessionGuard } from '../http/session.guard.js';
import { IdentityService } from './identity.service.js';
import { MeController } from './me.controller.js';

@Module({
  imports: [AuthModule, AuthorizationModule],
  controllers: [MeController],
  providers: [IdentityService, SessionGuard],
  exports: [IdentityService],
})
export class IdentityModule {}
