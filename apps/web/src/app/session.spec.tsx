/**
 * The session provider and the gate it feeds.
 *
 * What these tests are actually for. The frontend is not an authorization boundary, so proving
 * that a hidden button stays hidden proves very little. What is worth proving is the opposite
 * property: that this code invents nothing. Every user, company, role and permission it shows
 * came from a `/me` response, a refused switch changes nothing, and no secret is written
 * anywhere a later script could read it.
 *
 * `fetch` is stubbed per test and records every call, so an assertion can be about which
 * endpoint was reached rather than only about what ended up on screen.
 */

import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import { SessionGate } from './SessionGate';
import { SessionProvider, useSession, useSessionState } from './session';
import type { Me } from '@/services/session.service';

const ADMIN_ME: Me = {
  user: { id: 'u-1', email: 'admin@example.test', name: 'Ada Admin' },
  companies: [
    { id: 'c-1', name: 'North Trading', isActive: true },
    { id: 'c-2', name: 'South Trading', isActive: false },
  ],
  activeCompany: { id: 'c-1', name: 'North Trading' },
  roles: [{ key: 'administrator', name: 'Administrator' }],
  permissions: ['admin:users', 'sales:view', 'audit:view'],
};

const WAREHOUSE_ME: Me = {
  user: { id: 'u-2', email: 'wendy@example.test', name: 'Wendy Warehouse' },
  companies: [{ id: 'c-2', name: 'South Trading', isActive: true }],
  activeCompany: { id: 'c-2', name: 'South Trading' },
  roles: [{ key: 'warehouse', name: 'Warehouse Operator' }],
  permissions: ['inventory:view', 'inventory:move'],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];

/** Installs a fetch that answers from a table of routes and records every call. */
function stubFetch(routes: Record<string, () => { status: number; body?: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const key = `${method} ${input}`;
      calls.push({
        url: input,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      const handler = routes[key];
      if (!handler) {
        return Promise.resolve(
          new Response(null, { status: 404, statusText: 'Not Found' }),
        );
      }

      const { status, body } = handler();
      if (status === 204 || body === undefined) {
        return Promise.resolve(new Response(null, { status, statusText: 'No Content' }));
      }

      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function renderWithSession(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>{children}</SessionProvider>
    </QueryClientProvider>,
  );
}

/** Reports what a screen inside the gate can see, without any application chrome. */
function Inside() {
  const { user, activeCompany, companies, roles, permissions, can } = useSession();

  return (
    <div>
      <p>user:{user.name}</p>
      <p>email:{user.email}</p>
      <p>company:{activeCompany.name}</p>
      <p>companies:{companies.map((c) => c.name).join('|')}</p>
      <p>roles:{roles.map((r) => r.key).join('|')}</p>
      <p>permissions:{[...permissions].sort().join('|')}</p>
      <p>canAdmin:{String(can('admin:users'))}</p>
    </div>
  );
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('while the session is being loaded', () => {
  it('renders neither the application nor a sign-in form', async () => {
    // A request that never settles, which is what the first paint after a cold load looks like.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    expect(screen.getByText('Loading')).toBeDefined();
    expect(screen.queryByText(/^user:/)).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
});

describe('when nobody is signed in', () => {
  beforeEach(() => {
    stubFetch({ 'GET /api/me': () => ({ status: 401 }) });
  });

  it('shows the sign-in form', async () => {
    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByLabelText('Password');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeDefined();
  });

  it('renders nothing of the application', async () => {
    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByLabelText('Password');

    // Criterion: a protected screen must not expose authenticated state to a signed-out
    // browser. Not merely hidden by CSS: the component never renders, so nothing it would have
    // shown exists in the document at all.
    expect(screen.queryByText(/^user:/)).toBeNull();
    expect(screen.queryByText(/^company:/)).toBeNull();
    expect(screen.queryByText(/^permissions:/)).toBeNull();
  });

  it('treats a 401 as signed out rather than as an error', async () => {
    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByLabelText('Password');
    expect(screen.queryByText('Cannot reach the server')).toBeNull();
  });

  it('does not show a sign-in form when the server is unreachable', async () => {
    // A 500 is not a signed-out state. Offering a password box for a server that is not
    // answering invites someone to type one at nothing.
    stubFetch({ 'GET /api/me': () => ({ status: 500, body: { message: 'boom' } }) });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByText('Cannot reach the server');
    expect(screen.queryByLabelText('Password')).toBeNull();
  });
});

describe('signing in', () => {
  it('posts to the real endpoint and then asks who it is', async () => {
    let signedIn = false;
    stubFetch({
      'GET /api/me': () => (signedIn ? { status: 200, body: ADMIN_ME } : { status: 401 }),
      'POST /api/auth/login': () => {
        signedIn = true;
        return { status: 204 };
      },
    });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'admin@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByText('user:Ada Admin');

    const login = calls.find((call) => call.url === '/api/auth/login');
    expect(login?.method).toBe('POST');
    expect(login?.body).toEqual({ email: 'admin@example.test', password: 'hunter2' });

    // Identity came from a second request rather than from the login response.
    expect(calls.filter((call) => call.url === '/api/me').length).toBeGreaterThan(1);
  });

  it('keeps no password or token in browser storage', async () => {
    let signedIn = false;
    stubFetch({
      'GET /api/me': () => (signedIn ? { status: 200, body: ADMIN_ME } : { status: 401 }),
      'POST /api/auth/login': () => {
        signedIn = true;
        return { status: 204 };
      },
    });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'admin@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('user:Ada Admin');

    const stored = [
      ...Object.entries({ ...localStorage }),
      ...Object.entries({ ...sessionStorage }),
    ];

    // The session is an HttpOnly cookie. There is nothing for this code to store and it stores
    // nothing, including the email, which would be a small disclosure on a shared machine.
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('admin@example.test');
    expect(stored.filter(([key]) => key.startsWith('erp.demo'))).toEqual([]);
  });

  it('shows one message for a refused sign-in and stays signed out', async () => {
    stubFetch({
      'GET /api/me': () => ({ status: 401 }),
      'POST /api/auth/login': () => ({ status: 401, body: { message: 'Invalid' } }),
    });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('do not match');
    expect(screen.queryByText(/^user:/)).toBeNull();
  });
});

describe('when signed in', () => {
  beforeEach(() => {
    stubFetch({ 'GET /api/me': () => ({ status: 200, body: ADMIN_ME }) });
  });

  it('shows exactly what /me returned', async () => {
    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    expect(await screen.findByText('user:Ada Admin')).toBeDefined();
    expect(screen.getByText('email:admin@example.test')).toBeDefined();
    expect(screen.getByText('company:North Trading')).toBeDefined();
    expect(screen.getByText('companies:North Trading|South Trading')).toBeDefined();
    expect(screen.getByText('roles:administrator')).toBeDefined();
  });

  it('takes permissions from the response and adds none of its own', async () => {
    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByText('user:Ada Admin');

    // Exactly the three the server sent. An administrator role name is present too, and the
    // frontend does not expand it into the template's full permission list.
    expect(screen.getByText('permissions:admin:users|audit:view|sales:view')).toBeDefined();
    expect(screen.getByText('canAdmin:true')).toBeDefined();
  });

  it('reports a permission as absent when the server did not send it', async () => {
    stubFetch({ 'GET /api/me': () => ({ status: 200, body: WAREHOUSE_ME }) });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByText('user:Wendy Warehouse');
    expect(screen.getByText('canAdmin:false')).toBeDefined();
    expect(screen.getByText('permissions:inventory:move|inventory:view')).toBeDefined();
  });
});

describe('when signed in with no company entered', () => {
  it('offers the companies from /me and renders no application screen', async () => {
    stubFetch({
      'GET /api/me': () => ({
        status: 200,
        body: { ...ADMIN_ME, activeCompany: null },
      }),
    });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByRole('heading', { name: 'Choose a company' });
    expect(screen.getByRole('button', { name: 'North Trading' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'South Trading' })).toBeDefined();
    expect(screen.queryByText(/^permissions:/)).toBeNull();
  });

  it('says so plainly when the person belongs to no company', async () => {
    stubFetch({
      'GET /api/me': () => ({
        status: 200,
        body: { ...ADMIN_ME, companies: [], activeCompany: null, roles: [], permissions: [] },
      }),
    });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByText('No company access');
    expect(screen.queryByText(/^user:/)).toBeNull();
  });

  it('enters the only company automatically, through the server', async () => {
    let entered = false;
    const single = {
      ...WAREHOUSE_ME,
      activeCompany: null as Me['activeCompany'],
    };
    stubFetch({
      'GET /api/me': () => ({ status: 200, body: entered ? WAREHOUSE_ME : single }),
      'POST /api/me/company': () => {
        entered = true;
        return { status: 200, body: WAREHOUSE_ME };
      },
    });

    renderWithSession(
      <SessionGate>
        <Inside />
      </SessionGate>,
    );

    await screen.findByText('company:South Trading');

    // It sent the same request the button would send. Nothing was assumed locally.
    const call = calls.find((c) => c.url === '/api/me/company');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ companyId: 'c-2' });
  });
});

describe('switching company', () => {
  function Switcher() {
    const { switchCompany } = useSessionState();
    return (
      <button type="button" onClick={() => void switchCompany('c-2').catch(() => undefined)}>
        go
      </button>
    );
  }

  it('goes through the backend and takes the new state from its response', async () => {
    const switched: Me = {
      ...ADMIN_ME,
      activeCompany: { id: 'c-2', name: 'South Trading' },
      roles: [{ key: 'warehouse', name: 'Warehouse Operator' }],
      permissions: ['inventory:view'],
    };
    stubFetch({
      'GET /api/me': () => ({ status: 200, body: ADMIN_ME }),
      'POST /api/me/company': () => ({ status: 200, body: switched }),
    });

    renderWithSession(
      <SessionGate>
        <>
          <Inside />
          <Switcher />
        </>
      </SessionGate>,
    );

    await screen.findByText('company:North Trading');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    await screen.findByText('company:South Trading');

    const call = calls.find((c) => c.url === '/api/me/company');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ companyId: 'c-2' });

    // Roles and permissions came from the switch response, not from the identifier sent.
    expect(screen.getByText('roles:warehouse')).toBeDefined();
    expect(screen.getByText('permissions:inventory:view')).toBeDefined();
    expect(screen.getByText('canAdmin:false')).toBeDefined();
  });

  it('changes nothing when the server refuses', async () => {
    stubFetch({
      'GET /api/me': () => ({ status: 200, body: ADMIN_ME }),
      'POST /api/me/company': () => ({ status: 404, body: { message: 'Company not found' } }),
    });

    renderWithSession(
      <SessionGate>
        <>
          <Inside />
          <Switcher />
        </>
      </SessionGate>,
    );

    await screen.findByText('company:North Trading');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));

    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/me/company')).toBe(true);
    });

    // The refusal left the company, the roles and the permissions exactly where they were.
    expect(screen.getByText('company:North Trading')).toBeDefined();
    expect(screen.getByText('roles:administrator')).toBeDefined();
    expect(screen.getByText('permissions:admin:users|audit:view|sales:view')).toBeDefined();
  });
});

describe('signing out', () => {
  function SignOutButton() {
    const { signOut } = useSessionState();
    return (
      <button type="button" onClick={() => void signOut()}>
        leave
      </button>
    );
  }

  it('calls the backend and clears the session state', async () => {
    stubFetch({
      'GET /api/me': () => ({ status: 200, body: ADMIN_ME }),
      'POST /api/auth/logout': () => ({ status: 204 }),
    });

    renderWithSession(
      <SessionGate>
        <>
          <Inside />
          <SignOutButton />
        </>
      </SessionGate>,
    );

    await screen.findByText('user:Ada Admin');
    fireEvent.click(screen.getByRole('button', { name: 'leave' }));

    await screen.findByLabelText('Password');

    expect(calls.some((c) => c.url === '/api/auth/logout' && c.method === 'POST')).toBe(true);
    // Nothing of the previous person is left rendered.
    expect(screen.queryByText(/^user:/)).toBeNull();
    expect(screen.queryByText(/^permissions:/)).toBeNull();
  });
});
