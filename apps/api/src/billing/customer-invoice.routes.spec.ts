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
 * WHAT EACH ROUTE DEMANDS IS THE POINT OF THE LIST. Raising and editing a draft need
 * `invoices:create`; committing it to the ledger needs `invoices:post`. Section 6.2 keeps the
 * verbs apart because that split is what encodes segregation of duties, and collapsing them would
 * read as tidier and remove a control.
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
    ['post', 'invoices:post'],
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

  it('exposes exactly four routes, and only one of them posts', () => {
    // Pinned, so a fifth handler is a visible decision. Cancelling and crediting a posted invoice
    // are the two that will want to be next, and section 12.3 has ruled neither.
    expect(handlers().sort()).toEqual(['create', 'get', 'post', 'update']);

    const posting = handlers().filter(
      (handler) => accessFor(handler)?.kind === 'permission' &&
        (accessFor(handler) as { permission: string }).permission === 'invoices:post',
    );

    expect(posting).toEqual(['post']);
  });

  it('does not let the capability that raises a document also commit it', () => {
    // The segregation of duties in the catalogue, read off the routes. If posting ever declared
    // `invoices:create`, anyone who could draft an invoice could put it in the ledger.
    expect(accessFor('post')).not.toEqual({ kind: 'permission', permission: 'invoices:create' });
  });
});
