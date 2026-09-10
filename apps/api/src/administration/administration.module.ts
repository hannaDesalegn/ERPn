/**
 * Company administration.
 *
 * A module of its own rather than routes bolted onto identity or authorization, because it
 * depends on both and neither should depend on it. Identity resolves the company, authorization
 * decides what may be done there, and this composes the two into operations.
 */

import { Module } from '@nestjs/common';

import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { AdministrationController } from './administration.controller.js';

@Module({
  imports: [IdentityModule, AuthorizationModule],
  controllers: [AdministrationController],
})
export class AdministrationModule {}
