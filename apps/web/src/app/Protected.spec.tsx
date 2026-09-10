/**
 * Route level permission behaviour, and the rules that keep identity honest.
 *
 * Two different kinds of test live here, and the difference matters.
 *
 * The rendering tests below are about usability. A warehouse operator who types a general ledger
 * URL should meet an explanation rather than a screen of failed requests. None of them proves
 * anything about safety: the permission being checked came from `/me`, and the API refuses the
 * requests regardless of what this code decides to draw.
 *
 * The source tests at the bottom are about the property that does matter, which is that the
 * frontend has no second identity path to fall back on. They read files rather than render them,
 * because a mock user reintroduced "just for local development" would render perfectly.
 */

import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Protected } from './Protected';
import { SessionGate } from './SessionGate';
import { SessionProvider } from './session';
import type { Me } from '@/services/session.service';

const WAREHOUSE_ME: Me = {
  user: { id: 'u-2', email: 'wendy@example.test', name: 'Wendy Warehouse' },
  companies: [{ id: 'c-2', name: 'South Trading', isActive: true }],
  activeCompany: { id: 'c-2', name: 'South Trading' },
  roles: [{ key: 'warehouse', name: 'Warehouse Operator' }],
  permissions: ['inventory:view', 'inventory:move'],
};

function stubMe(me: Me | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        me
          ? new Response(JSON.stringify(me), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response(null, { status: 401, statusText: 'Unauthorized' }),
      ),
    ),
  );
}

function renderGuarded(me: Me | null, permission: 'admin:users' | 'inventory:view') {
  stubMe(me);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <SessionGate>
          <Protected permission={permission}>
            <p>the general ledger</p>
          </Protected>
        </SessionGate>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a guarded route', () => {
  it('renders the page when the server reported the permission', async () => {
    renderGuarded(WAREHOUSE_ME, 'inventory:view');

    expect(await screen.findByText('the general ledger')).toBeDefined();
  });

  it('renders a forbidden screen instead of the page when it did not', async () => {
    renderGuarded(WAREHOUSE_ME, 'admin:users');

    await screen.findByText('You do not have access to this page');
    // The page is absent from the document rather than hidden, so nothing it would have
    // rendered, or fetched on mount, happens at all.
    expect(screen.queryByText('the general ledger')).toBeNull();
  });

  it('names the company, because the same person may hold it elsewhere', async () => {
    renderGuarded(WAREHOUSE_ME, 'admin:users');

    const explanation = await screen.findByText(/admin:users permission/);
    expect(explanation.textContent).toContain('South Trading');
  });

  it('renders nothing at all for a signed-out browser', async () => {
    renderGuarded(null, 'inventory:view');

    await screen.findByLabelText('Password');
    expect(screen.queryByText('the general ledger')).toBeNull();
    expect(screen.queryByText('You do not have access to this page')).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * The source of every file under app, layouts and services, read through Vite.
 *
 * `import.meta.glob` rather than the filesystem, so the tests resolve modules the same way the
 * build does and the spec needs no Node types leaking into an application tsconfig.
 *
 * The globs are rooted at the project rather than written relative to this file. A relative glob
 * keys a sibling as `./session.tsx` and a cousin as `../layouts/AppShell.tsx`, so half the
 * lookups below silently missed and the tests failed for a reason that had nothing to do with
 * what they check.
 */
// The options must be written out at each call. Vite parses this at build time and rejects a
// variable, because it has to know the glob and its options without running anything.
const sources: Record<string, string> = {
  ...(import.meta.glob('/src/app/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob('/src/layouts/**/*.{ts,tsx}', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>),
  ...(import.meta.glob('/src/services/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>),
};

const sourceOf = (path: string): string => {
  const found = sources[path];
  if (found === undefined) throw new Error(`No source read for ${path}`);
  return found;
};

describe('the mock identity path is gone', () => {
  const sessionFiles = [
    '/src/app/session.tsx',
    '/src/app/SessionGate.tsx',
    '/src/services/session.service.ts',
  ];

  it('found the files it is checking', () => {
    // Without this a rename turns every assertion below into a vacuous pass over nothing.
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    for (const file of sessionFiles) {
      expect(sourceOf(file).length).toBeGreaterThan(0);
    }
  });

  it.each(sessionFiles)('%s builds identity from no fixture data', (file) => {
    const source = sourceOf(file);

    expect(source).not.toContain('@/mocks');
    expect(source).not.toContain('permissionsFor');
    expect(source).not.toContain('ROLES[');
  });

  it('has no role switcher left in the application shell', () => {
    // Section 16.1 required this removed or gated behind a development flag. It is removed: no
    // switcher and no flag, because a flag is a second code path nobody runs and therefore
    // nobody notices rotting.
    const shell = sourceOf('/src/layouts/AppShell.tsx');

    expect(shell).not.toContain('switchUser');
    expect(shell).not.toContain('availableUsers');
    expect(shell).not.toContain('role-switcher');
    expect(shell).not.toContain('@/mocks');
  });

  it('leaves no file under app or layouts importing fixtures', () => {
    // The same rule the lint configuration enforces, asserted here as well. The lint rule stops
    // it being reintroduced; this fails if someone edits the lint rule.
    const offenders = Object.entries(sources)
      .filter(([path]) => path.startsWith('/src/app/') || path.startsWith('/src/layouts/'))
      .filter(([path]) => !path.includes('.spec.'))
      .filter(([, source]) => source.includes('@/mocks'))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });

  it.each(sessionFiles)('%s touches no browser storage and no cookie', (file) => {
    // Matched as property access rather than as a bare word, so the comments in these files
    // explaining that they store nothing do not fail the test that says so.
    const source = sourceOf(file);

    expect(source).not.toMatch(/\blocalStorage\s*[.[]/);
    expect(source).not.toMatch(/\bsessionStorage\s*[.[]/);
    expect(source).not.toMatch(/\bdocument\s*\.\s*cookie/);
    expect(source).not.toMatch(/\bindexedDB\b/);
  });

  it('sends credentials with every request rather than a token it holds', () => {
    const client = sourceOf('/src/services/client.ts');

    expect(client).toContain("credentials: 'include'");
    // No Authorization header assembled anywhere, which would mean a token this code can read.
    expect(client).not.toContain('Authorization');
    expect(client).not.toContain('Bearer');
  });
});
