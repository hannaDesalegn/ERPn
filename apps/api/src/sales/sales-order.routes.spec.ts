/**
 * What each sales order route declares it needs.
 *
 * Section 6.2 makes the declaration the operation level control, and the startup audit refuses a
 * route that declares nothing at all. What the audit cannot know is whether a route declares the
 * right thing, and that is what this pins.
 *
 * WHY IT IS A SEPARATE TEST RATHER THAN AN HTTP ONE. Every operation re-checks its own capability
 * inside its transaction, which is deliberate defence in depth and also means an HTTP test cannot
 * tell the two layers apart: widening the route declaration to `sales:view` leaves every
 * behavioural test green, because the operation still refuses and the caller still sees 403. The
 * outer layer is worth keeping correct on its own, so it is asserted on its own. A route that
 * admits a caller the operation will refuse is a route that does work it did not need to do, and
 * it is one edit away from being the only check there is.
 *
 * Read off the metadata rather than from a list written here twice, so a decorator that is
 * removed fails rather than a copy of it going stale.
 */

import 'reflect-metadata';

import { ROUTE_ACCESS, type RouteAccess } from '../authorization/route-access.js';
import { SalesOrderController } from './sales-order.controller.js';

const accessFor = (method: string): RouteAccess | undefined => {
  const handler = (SalesOrderController.prototype as unknown as Record<string, object | undefined>)[
    method
  ];
  if (handler === undefined) throw new Error(`${method} is not a handler on this controller`);

  return Reflect.getMetadata(ROUTE_ACCESS, handler) as RouteAccess | undefined;
};

describe('the sales order routes', () => {
  it.each([
    ['create', 'sales:create'],
    ['list', 'sales:view'],
    ['get', 'sales:view'],
    ['update', 'sales:create'],
    ['confirm', 'sales:confirm'],
    ['cancel', 'sales:cancel'],
    ['auditEvents', 'audit:view'],
  ])('%s requires %s', (method, permission) => {
    expect(accessFor(method)).toEqual({ kind: 'permission', permission });
  });

  it('declares access on every handler, so none is admitted by default', () => {
    // The startup audit fails the process over this. Failing here as well means it is caught
    // before a process ever starts.
    const handlers = Object.getOwnPropertyNames(SalesOrderController.prototype).filter(
      (name) => name !== 'constructor' && name !== 'conflict',
    );

    for (const handler of handlers) {
      expect(accessFor(handler)).toBeDefined();
    }
  });

  it('leaves no sales route public or merely authenticated', () => {
    // Section 6.2 confines the authenticated kind to `/me` and the company switch by rule. A
    // sales route reaching for either would be admitting a caller with no capability at all.
    const handlers = Object.getOwnPropertyNames(SalesOrderController.prototype).filter(
      (name) => name !== 'constructor' && name !== 'conflict',
    );

    for (const handler of handlers) {
      expect(accessFor(handler)?.kind).toBe('permission');
    }
  });
});
