/**
 * What each customer invoice route declares it needs.
 *
 * Section 6.2 makes the declaration the operation level control, and the startup audit refuses a
 * route that declares nothing at all. What the audit cannot know is whether a route declares the
 * right thing, and that is what this pins.
 *
 * WHY IT IS A SEPARATE TEST RATHER THAN AN HTTP ONE, in the words `sales-order.routes.spec.ts`
 * already uses: widening a route declaration leaves the behavioural tests green, because the
 * operation beneath it refuses on its own. The outer layer is worth keeping correct on its own.
 *
 * WHAT IS NOT DECLARED HERE MATTERS TOO. No route requires `invoices:post`. That capability exists
 * in the catalogue and posting is the next increment; a route claiming it today would be a control
 * that does nothing.
 */

import 'reflect-metadata';

import { ROUTE_ACCESS, type RouteAccess } from '../authorization/route-access.js';
import { CustomerInvoiceController } from './customer-invoice.controller.js';

const handlers = () =>
  Object.getOwnPropertyNames(CustomerInvoiceController.prototype).filter(
    (name) => name !== 'constructor' && name !== 'conflict' && name !== 'contextFor',
  );

const accessFor = (method: string): RouteAccess | undefined => {
  const handler = (
    CustomerInvoiceController.prototype as unknown as Record<string, object | undefined>
  )[method];
  if (handler === undefined) throw new Error(`${method} is not a handler on this controller`);

  return Reflect.getMetadata(ROUTE_ACCESS, handler) as RouteAccess | undefined;
};

describe('the customer invoice routes', () => {
  it.each([
    ['create', 'invoices:create'],
    ['update', 'invoices:create'],
    ['get', 'invoices:view'],
  ])('%s requires %s', (method, permission) => {
    expect(accessFor(method)).toEqual({ kind: 'permission', permission });
  });

  it('declares access on every handler, so none is admitted by default', () => {
    // The startup audit fails the process over this. Failing here as well means it is caught
    // before a process ever starts.
    for (const handler of handlers()) {
      expect(accessFor(handler)).toBeDefined();
    }
  });

  it('leaves no invoice route public or merely authenticated', () => {
    // Section 6.2 confines the authenticated kind to `/me` and the company switch by rule. An
    // invoice route reaching for either would admit a caller with no capability at all.
    for (const handler of handlers()) {
      expect(accessFor(handler)?.kind).toBe('permission');
    }
  });

  it('exposes exactly three routes, and none of them posts', () => {
    // The stopping boundary of this package, pinned. A fourth handler here means the posting
    // endpoint arrived, and it should arrive with its own increment rather than inside this one.
    expect(handlers().sort()).toEqual(['create', 'get', 'update']);

    for (const handler of handlers()) {
      expect(accessFor(handler)).not.toEqual({ kind: 'permission', permission: 'invoices:post' });
    }
  });
});
