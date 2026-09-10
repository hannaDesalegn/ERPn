/**
 * Authentication.
 *
 * Contract section 5.4: authentication answers "who is this" and nothing else. Authorization,
 * company context and the HTTP surface are separate layers in separate increments, so nothing
 * here decides what an actor may do.
 */

import { Module } from '@nestjs/common';

import { PasswordHasher } from './password-hasher.js';

@Module({
  providers: [PasswordHasher],
  exports: [PasswordHasher],
})
export class AuthModule {}
