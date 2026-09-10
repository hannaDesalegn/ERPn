/**
 * The catalogue, and its agreement with the vocabulary it came from.
 *
 * Contract section 6.2 carries the permission strings forward from the existing model, and
 * section 2.7 names the six role shapes. Until the frontend consumes `/me`, both definitions
 * exist in two places: the backend catalogue, which is authoritative under section 3.1, and the
 * frontend copy that predates it.
 *
 * Two copies of a security vocabulary is exactly the sort of thing that agrees on the day it is
 * written and disagrees six months later, in a way nobody notices because each side is
 * internally consistent. So the comparison is a test rather than a convention. The frontend copy
 * is registered as temporary in section 16.1; this keeps it honest until it is deleted.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isPermission,
  PERMISSIONS,
  ROLE_KEYS,
  ROLE_TEMPLATES,
  ROLE_TEMPLATE_LIST,
  templatePermissions,
} from './permissions.js';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'src');

const securitySource = readFileSync(join(WEB_SRC, 'domain', 'security.ts'), 'utf8');
const permissionsSource = readFileSync(join(WEB_SRC, 'lib', 'permissions.ts'), 'utf8');

describe('The permission catalogue', () => {
  it('is a closed list with no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('uses resource:action throughout', () => {
    // Section 6.2 fixes the shape. A permission that does not parse this way would still work
    // as an opaque string and would break every convention a reader relies on.
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+:[a-z_]+$/);
    }
  });

  it('recognises exactly the strings it lists', () => {
    for (const permission of PERMISSIONS) {
      expect(isPermission(permission)).toBe(true);
    }

    for (const invented of ['sales:*', 'admin:everything', 'SALES:VIEW', '', 'sales']) {
      expect(isPermission(invented)).toBe(false);
    }
  });

  it('keeps create separate from the state changing verbs', () => {
    // Section 6.2: this split is the segregation of duties control. A merge would look like
    // simplification and would remove a fraud control, so it is pinned.
    expect(PERMISSIONS).toContain('purchasing:create');
    expect(PERMISSIONS).toContain('purchasing:approve');
    expect(PERMISSIONS).toContain('invoices:create');
    expect(PERMISSIONS).toContain('invoices:post');
    expect(PERMISSIONS).toContain('sales:create');
    expect(PERMISSIONS).toContain('sales:confirm');
  });
});

describe('The catalogue against the frontend vocabulary', () => {
  /** Every `'permission:string'` literal in the Permission union. */
  const declaredInWeb = [...securitySource.matchAll(/\|\s*'([a-z]+:[a-z_]+)'/g)].map(
    (match) => match[1],
  );

  it('found the frontend definitions, rather than passing over an empty list', () => {
    // Without this, a moved or renamed file turns every comparison below into a vacuous pass.
    expect(declaredInWeb.length).toBeGreaterThan(20);
    expect(permissionsSource).toContain('export const ROLES');
  });

  it('lists exactly the permissions the frontend union declares', () => {
    expect([...PERMISSIONS].sort()).toEqual([...declaredInWeb].sort());
  });

  it('lists exactly the role keys the frontend declares', () => {
    // The RoleKey union taken by its bounds rather than by a per-line pattern. The last member
    // ends in a semicolon rather than a newline, which a line-shaped regex silently dropped, and
    // a silently short list would have compared equal to a silently short catalogue.
    const start = securitySource.indexOf('export type RoleKey =');
    const block = securitySource.slice(start, securitySource.indexOf(';', start));
    const declaredKeys = [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

    expect(declaredKeys).toHaveLength(ROLE_KEYS.length);
    expect([...ROLE_KEYS].sort()).toEqual([...new Set(declaredKeys)].sort());
  });

  it.each(ROLE_KEYS)('grants %s exactly what the frontend role definition grants', (key) => {
    // The frontend file lists each role as a block. Take the block, then take the permission
    // literals inside it, which is enough to compare sets without importing across workspaces.
    const block = permissionsSource.slice(
      permissionsSource.indexOf(`  ${key}: {`),
      permissionsSource.indexOf('},', permissionsSource.indexOf(`  ${key}: {`)),
    );
    const granted = [...block.matchAll(/'([a-z]+:[a-z_]+)'/g)].map((m) => m[1]);

    expect(granted.length).toBeGreaterThan(0);
    expect([...templatePermissions(key)].sort()).toEqual([...new Set(granted)].sort());
  });
});

describe('The default role templates', () => {
  it('covers every role key, and only those', () => {
    expect(Object.keys(ROLE_TEMPLATES).sort()).toEqual([...ROLE_KEYS].sort());
    expect(ROLE_TEMPLATE_LIST).toHaveLength(ROLE_KEYS.length);
  });

  it('grants nothing outside the catalogue', () => {
    // The write-time check in section 2.7 enforces this for stored rows. This enforces it for
    // the templates themselves, which are what a company starts with.
    for (const template of ROLE_TEMPLATE_LIST) {
      for (const permission of template.permissions) {
        expect(isPermission(permission)).toBe(true);
      }
    }
  });

  it('gives no template a duplicate permission', () => {
    for (const template of ROLE_TEMPLATE_LIST) {
      expect(new Set(template.permissions).size).toBe(template.permissions.length);
    }
  });

  it('makes the administrator a superset of every other template', () => {
    // Not a rule the contract states, and true of the shapes it names. Pinned so that adding a
    // capability to one role and forgetting the administrator shows up here rather than as a
    // support ticket about an administrator who cannot do something.
    const administrator = templatePermissions('administrator');

    for (const key of ROLE_KEYS.filter((k) => k !== 'administrator')) {
      for (const permission of templatePermissions(key)) {
        expect(administrator.has(permission)).toBe(true);
      }
    }
  });

  it('keeps segregation of duties intact in the shapes that carry it', () => {
    // Section 2.7 names these divisions explicitly. Each is a control rather than a preference,
    // so each is asserted rather than left to the reader of the template list.
    expect(templatePermissions('purchasing').has('purchasing:create')).toBe(true);
    expect(templatePermissions('purchasing').has('purchasing:approve')).toBe(false);

    expect(templatePermissions('sales').has('sales:confirm')).toBe(true);
    expect(templatePermissions('sales').has('invoices:post')).toBe(false);
    expect(templatePermissions('sales').has('payments:register')).toBe(false);

    expect(templatePermissions('warehouse').has('inventory:move')).toBe(true);
    expect(templatePermissions('warehouse').has('reports:financial')).toBe(false);
    expect(templatePermissions('warehouse').has('invoices:view')).toBe(false);

    expect(templatePermissions('accountant').has('accounting:post')).toBe(true);
    expect(templatePermissions('accountant').has('sales:create')).toBe(false);

    expect(templatePermissions('manager').has('purchasing:approve')).toBe(true);
    expect(templatePermissions('manager').has('accounting:post')).toBe(false);
  });

  it('reserves user and settings administration to the administrator', () => {
    for (const key of ROLE_KEYS.filter((k) => k !== 'administrator')) {
      expect(templatePermissions(key).has('admin:users')).toBe(false);
      expect(templatePermissions(key).has('admin:settings')).toBe(false);
    }
  });
});
