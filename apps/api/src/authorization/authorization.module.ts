/**
 * Authorization: what a person may do in the company they are working in.
 *
 * Section 15.7 makes a module a business boundary. This one owns the permission catalogue, the
 * resolution of a membership into effective permissions, and the guard that refuses a request
 * without them. Identity asks it what a membership grants; nothing else reads role or permission
 * rows for itself.
 *
 * It depends on identity for the company context and not the other way round, which keeps the
 * three questions in section 5.4 and 6.1 in their order: who is this, where are they working,
 * what may they do there.
 */

import { Module } from '@nestjs/common';

import { AuthorizationService } from './authorization.service.js';

@Module({
  providers: [AuthorizationService],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}
