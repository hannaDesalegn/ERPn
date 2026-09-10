/**
 * Authentication.
 *
 * Contract section 5.4: authentication answers "who is this" and nothing else. Authorization,
 * company context and the HTTP surface are separate layers in separate increments, so nothing
 * here decides what an actor may do.
 *
 * No controller yet, deliberately. The HTTP surface brings cookies, CSRF and a session guard
 * with it, and section 17.3 places those in a later increment. The service is complete and
 * tested without one.
 */

import { Module } from '@nestjs/common';

import { AuthenticationService } from './authentication.service.js';
import { PasswordHasher } from './password-hasher.js';

@Module({
  providers: [PasswordHasher, AuthenticationService],
  exports: [PasswordHasher, AuthenticationService],
})
export class AuthModule {}
