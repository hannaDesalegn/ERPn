/**
 * Authentication.
 *
 * Contract section 5.4: authentication answers "who is this" and nothing else. Authorization,
 * company context and the HTTP surface are separate layers in separate increments, so nothing
 * here decides what an actor may do.
 *
 * The controller is a translation layer and nothing more. Every rule it enforces is in the
 * service, which is testable without a web server, and the controller's own job is to keep the
 * token out of the response body and the rejection reasons collapsed into one answer.
 */

import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller.js';
import { AuthenticationService } from './authentication.service.js';
import { PasswordHasher } from './password-hasher.js';

@Module({
  controllers: [AuthController],
  providers: [PasswordHasher, AuthenticationService],
  exports: [PasswordHasher, AuthenticationService],
})
export class AuthModule {}
