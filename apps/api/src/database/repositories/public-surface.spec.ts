/**
 * The public surface of the data layer, asserted rather than assumed.
 *
 * Contract section 6.3: "Constructing an unscoped query must not be possible through the public
 * interface of the data layer." That is a property of what the module exports, so it is tested
 * by inspecting the exports rather than by reading the code and trusting it.
 *
 * These are unit tests. They need no database, because the claim is about the module surface.
 */

import * as dataLayer from '../index.js';
import { actorScope, systemScope } from '../scope.js';

describe('the public surface of the data layer', () => {
  const exported = Object.keys(dataLayer).sort();

  it('exports the unit of work and the scope constructors, and nothing that queries', () => {
    expect(exported).toEqual([
      'ConcurrencyConflictError',
      'RecordNotFoundError',
      'UnitOfWork',
      'UnknownPermissionError',
      'actorScope',
      'isActorScope',
      'principalScope',
      'systemScope',
    ]);
  });

  it.each([
    'DrizzleCompanyRepository',
    'DrizzleMembershipRepository',
    'DrizzleUserRepository',
    'DrizzleAuditRepository',
  ])('does not export %s, so nobody can construct one with a handle of their choosing', (name) => {
    expect(exported).not.toContain(name);
  });

  it.each(['DATABASE', 'DATABASE_POOL', 'Pool', 'drizzle', 'db'])(
    'does not export %s, so nobody can reach the connection directly',
    (name) => {
      expect(exported).not.toContain(name);
    },
  );

  it('exposes no way to obtain a repository except through the unit of work', () => {
    // Every export is either the unit of work, a scope helper, or an error class. There is no
    // factory, no getter and no singleton that hands out a repository.
    const nonUnitOfWork = exported.filter((name) => name !== 'UnitOfWork');

    for (const name of nonUnitOfWork) {
      const value = (dataLayer as Record<string, unknown>)[name];
      const isScopeHelper = ['actorScope', 'principalScope', 'systemScope', 'isActorScope'].includes(
        name,
      );
      const isErrorClass = name.endsWith('Error');

      expect(isScopeHelper || isErrorClass).toBe(true);
      expect(typeof value).toBe('function');
    }
  });
});

describe('scope construction', () => {
  const VALID = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    companyId: 'aaaaaaaa-0000-0000-0000-00000000000a',
    userId: '99999999-9999-9999-9999-99999999999a',
  };

  it('builds an actor scope from trusted values', () => {
    const scope = actorScope(VALID);

    expect(scope.kind).toBe('actor');
    expect(scope.tenantId).toBe(VALID.tenantId);
  });

  it.each([
    ['a non-UUID tenant', { ...VALID, tenantId: 'not-a-uuid' }],
    ['an empty tenant', { ...VALID, tenantId: '' }],
    // A caller splicing SQL into a context value would be rewriting the tenant boundary itself.
    ['an injection attempt', { ...VALID, tenantId: "' OR '1'='1" }],
    ['a non-UUID company', { ...VALID, companyId: '*' }],
  ])('rejects %s rather than passing it to the database', (_label, input) => {
    expect(() => actorScope(input)).toThrow(/must be a UUID/);
  });

  it('builds a system scope that reaches no tenant unless one is named', () => {
    const scope = systemScope('scheduled-maintenance');

    expect(scope.kind).toBe('system');
    expect(scope.tenantId).toBeUndefined();
  });

  it('builds a system scope confined to one named tenant for provisioning', () => {
    const scope = systemScope('tenant-provisioning', { tenantId: VALID.tenantId });

    expect(scope.tenantId).toBe(VALID.tenantId);
  });

  it('validates the tenant on a system scope too', () => {
    expect(() => systemScope('tenant-provisioning', { tenantId: 'nope' })).toThrow(
      /must be a UUID/,
    );
  });
});

describe('the repository interfaces', () => {
  it('take no tenant or company argument, because scope is not the callers to supply', async () => {
    // A signature that accepted a tenant id would be an invitation to read one out of a request
    // body and hand it in as authority, which is the vulnerability this layer exists to prevent.
    // TypeScript enforces this at compile time; this test records the intent so that widening a
    // signature is a deliberate, visible act rather than a quiet one.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./types.ts', import.meta.url), 'utf8'),
    );

    const publicMethodSignatures = source.match(/^\s{2}\w+\([^)]*\)/gm) ?? [];
    const offending = publicMethodSignatures.filter((signature) =>
      /\btenantId\b|\bcompanyId\b/.test(signature),
    );

    expect(offending).toEqual([]);
  });
});
