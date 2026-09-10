/**
 * How a route declares what it requires.
 *
 * Contract section 6.2: deny by default, every route declares the permission it requires, and a
 * route that declares none fails to register. This file is the declaration vocabulary. The guard
 * enforces it per request and the startup audit enforces the "fails to register" half.
 *
 * THREE DECLARATIONS AND NO DEFAULT. There is deliberately no fourth option meaning "whatever
 * is convenient", and no fallback for a handler that says nothing. A missing declaration is not
 * a permissive state to be inherited; it is the one thing this mechanism exists to catch. That
 * is why every value below is explicit even when it looks like it could be inferred.
 *
 *   @Public              no session needed. Sign in, sign out, health.
 *   @AuthenticatedOnly   a live session, and nothing more. `/me` and the company switch.
 *   @RequirePermission   a live session, a company entered, and that capability in it.
 *
 * `@AuthenticatedOnly` is the one that needs justifying, because it looks like a hole. It is
 * used for the two routes whose whole purpose is to tell a caller what they may do and where:
 * `/me`, which reports the answer, and the company switch, which is how a session acquires a
 * company in the first place. Requiring a permission for either would mean needing a company
 * before you could choose one. Neither returns anything a caller did not already prove they may
 * see: `/me` reports only that caller's own memberships, and the switch only accepts a company
 * they are already a member of.
 */

import { SetMetadata } from '@nestjs/common';

import type { Permission } from './permissions.js';

/** A symbol, so no decorator from another library can collide with it by string. */
export const ROUTE_ACCESS = Symbol('ROUTE_ACCESS');

export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: Permission };

/**
 * Reachable without a session.
 *
 * Every use is a decision worth defending in review, which is why this is a decorator with a
 * name rather than the absence of one.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS, { kind: 'public' } satisfies RouteAccess);

/** A live session and nothing more. See the note above on why this exists at all. */
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS, { kind: 'authenticated' } satisfies RouteAccess);

/**
 * A live session, a company entered, and this capability held in that company.
 *
 * The permission is typed against the catalogue, so a route cannot require a string that does
 * not exist. A required permission nobody can hold would deny everyone, which is the safe
 * direction and still a bug worth catching at compile time.
 */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(ROUTE_ACCESS, { kind: 'permission', permission } satisfies RouteAccess);
