/**
 * Confirming a sales order from the interface.
 *
 * WHAT THESE TESTS ARE FOR. The frontend is not an authorization boundary and decides nothing
 * about whether an order may be confirmed, so proving a hidden button stays hidden would prove
 * very little. What is worth proving is that this screen invents nothing: it calls the real
 * endpoint, sends no body, carries one idempotency key per intent, and shows the status and
 * document number the server answered with rather than any it worked out.
 *
 * `fetch` is stubbed per test and records every call, so an assertion can be about which endpoint
 * was reached and what was sent, rather than only about what ended up on screen. The session comes
 * from a real `/me` response through the real provider, because the permission gate is part of
 * what is being exercised.
 *
 * The order itself still comes from the fixture layer. That is the honest state of a half
 * migrated module under section 16.1: confirmation has an endpoint and reading an order does not.
 */

import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionGate } from '@/app/SessionGate';
import { SessionProvider } from '@/app/session';
import type { Me } from '@/services/session.service';
import { SalesOrderDetailPage } from './SalesOrderDetailPage';

/** A draft in the fixture set, which is what the confirm action is gated on. */
const DRAFT_ORDER = 'so-055';
const CONFIRM_URL = `/api/sales-orders/${DRAFT_ORDER}/confirm`;

const SELLER: Me = {
  user: { id: 'u-1', email: 'sam@example.test', name: 'Sam Seller' },
  companies: [{ id: 'c-1', name: 'North Trading', isActive: true }],
  activeCompany: { id: 'c-1', name: 'North Trading' },
  roles: [{ key: 'sales', name: 'Sales' }],
  permissions: ['sales:view', 'sales:confirm'],
};

/** Signed in, in the same company, without the capability. */
const CLERK: Me = {
  ...SELLER,
  user: { id: 'u-2', email: 'clara@example.test', name: 'Clara Clerk' },
  roles: [{ key: 'warehouse', name: 'Warehouse' }],
  permissions: ['sales:view'],
};

const CONFIRMED = {
  id: DRAFT_ORDER,
  status: 'confirmed',
  docNumber: 'SO-0001',
  reservations: 2,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];

/** Installs a fetch that answers from a table of routes and records every call. */
function stubFetch(routes: Record<string, () => { status: number; body?: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: input,
        method,
        headers: Object.fromEntries(
          Object.entries((init?.headers ?? {}) as Record<string, string>),
        ),
        body: init?.body ?? undefined,
      });

      const handler = routes[`${method} ${input}`];
      if (!handler) {
        return Promise.resolve(new Response(null, { status: 404, statusText: 'Not Found' }));
      }

      const { status, body } = handler();
      if (body === undefined) {
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

/** For the two tests that need more than a route table: a held response, and a failed request. */
function stubFetchWith(
  implementation: (input: string, init?: RequestInit) => Promise<Response>,
): void {
  vi.stubGlobal('fetch', vi.fn(implementation));
}

/**
 * Mounts the screen behind the real session gate.
 *
 * The gate matters: `useSession` refuses to answer until a session has resolved, which is the
 * provider being honest about not knowing yet rather than guessing. A test that skipped it would
 * be rendering a screen in a state the application never shows.
 */
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <SessionGate>
          <MemoryRouter initialEntries={[`/sales/orders/${DRAFT_ORDER}`]}>
            <Routes>
              <Route path="/sales/orders/:id" element={<SalesOrderDetailPage />} />
            </Routes>
          </MemoryRouter>
        </SessionGate>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function renderPage(me: Me, confirm: () => { status: number; body?: unknown }) {
  stubFetch({
    'GET /api/me': () => ({ status: 200, body: me }),
    [`POST ${CONFIRM_URL}`]: confirm,
  });

  return mount();
}

const confirmButton = () => screen.getByRole('button', { name: /confirm order/i });

const waitForPage = () => waitFor(() => expect(screen.getByText(/order details/i)).toBeDefined());

const confirmCalls = () => calls.filter((call) => call.url === CONFIRM_URL);

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. What is rendered, and on what.
// ---------------------------------------------------------------------------

describe('the confirm action', () => {
  it('is offered on a draft to someone holding sales:confirm', async () => {
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    expect(confirmButton()).toBeDefined();
  });

  it('is not offered without the capability', async () => {
    // Not a security control, and the tests below are the reason: the server refuses the same
    // request whatever this screen drew. It is there so the interface does not offer work the
    // person cannot do.
    renderPage(CLERK, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    expect(screen.queryByRole('button', { name: /confirm order/i })).toBeNull();
  });

  it('calls nothing until it is pressed', async () => {
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    expect(confirmCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2, 3 and 4. The request.
// ---------------------------------------------------------------------------

describe('the request it sends', () => {
  it('posts to the confirmation endpoint for this order', async () => {
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(confirmCalls()[0]?.method).toBe('POST');
  });

  it('sends no body, because nothing about a confirmation is the caller\'s to decide', async () => {
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(confirmCalls()[0]?.body).toBeUndefined();
  });

  it('carries an idempotency key', async () => {
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(confirmCalls()[0]?.headers['Idempotency-Key']).toMatch(/.+/);
  });

  it('reuses one key across retries, because a retry is the same intent', async () => {
    // Section 11: one key per user intent, not per network attempt. A fresh key on each attempt
    // would make every retry a new intent and leave the server unable to tell them apart.
    let attempt = 0;
    renderPage(SELLER, () => {
      attempt += 1;
      return attempt === 1
        ? { status: 500, body: { message: 'boom' } }
        : { status: 200, body: CONFIRMED };
    });
    await waitForPage();

    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmCalls()).toHaveLength(1));

    fireEvent.click(confirmButton());
    await waitFor(() => expect(confirmCalls()).toHaveLength(2));

    const keys = confirmCalls().map((call) => call.headers['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------
// 5, 6 and 7. Pending, and what success shows.
// ---------------------------------------------------------------------------

describe('while it is running and after it finishes', () => {
  it('shows a pending state and refuses a second press', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    stubFetchWith(async (input, init) => {
      if (input !== CONFIRM_URL) {
        return new Response(JSON.stringify(SELLER), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      calls.push({ url: input, method: 'POST', headers: {}, body: init?.body ?? undefined });
      await held;
      return new Response(JSON.stringify(CONFIRMED), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    mount();
    await waitForPage();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByRole('button', { name: /confirming/i })).toBeDefined());
    const pending = screen.getByRole('button', { name: /confirming/i }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);

    fireEvent.click(pending);
    expect(calls.filter((call) => call.url === CONFIRM_URL)).toHaveLength(1);

    release();
    await waitFor(() => expect(screen.getByText('SO-0001')).toBeDefined());
  });

  it('shows the status and document number the server answered with', async () => {
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    // The fixture order is a draft numbered SO-2026-0055. After confirming, the screen must show
    // what the server issued, not what the fixture said.
    expect(screen.getByText('SO-2026-0055')).toBeDefined();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText('SO-0001')).toBeDefined());
    expect(screen.queryByText('SO-2026-0055')).toBeNull();
  });

  it('stops offering confirmation once the order is confirmed', async () => {
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.queryByRole('button', { name: /confirm order/i })).toBeNull());
  });

  it('does not invent a number the server did not send', async () => {
    renderPage(SELLER, () => ({
      status: 200,
      body: { ...CONFIRMED, docNumber: 'SO-0042', status: 'confirmed' },
    }));
    await waitForPage();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(screen.getByText('SO-0042')).toBeDefined());
  });
});

// ---------------------------------------------------------------------------
// 8 to 12. Every refusal.
// ---------------------------------------------------------------------------

describe('when the server refuses', () => {
  const refusal = async (status: number, message: string) => {
    renderPage(SELLER, () => ({ status, body: { message, statusCode: status } }));
    await waitForPage();

    fireEvent.click(confirmButton());

    return waitFor(() => screen.getByRole('alert'));
  };

  it('shows what the server said about insufficient stock', async () => {
    // The server's own words, because only it knows how much there was. A generic message here
    // would turn a useful answer into "Unprocessable Entity".
    const alert = await refusal(422, 'Only 5.000000 available, and 10.000000 was asked for');

    expect(alert.textContent).toMatch(/Only 5.000000 available/);
  });

  it('explains an authorization refusal without repeating the server\'s bare word', async () => {
    const alert = await refusal(403, 'Forbidden');

    expect(alert.textContent).toMatch(/do not have permission/i);
  });

  it('shows a conflict when the order moved under the caller', async () => {
    const alert = await refusal(
      409,
      'Sales order so-055 was modified by someone else. Re-read it and try again.',
    );

    expect(alert.textContent).toMatch(/modified by someone else/i);
  });

  it('shows the transition refusal when the order is already confirmed', async () => {
    const alert = await refusal(409, 'A sales order cannot move from confirmed to confirmed');

    expect(alert.textContent).toMatch(/cannot move from confirmed to confirmed/);
  });

  it('shows an idempotency conflict as the conflict it is', async () => {
    const alert = await refusal(409, 'The idempotency key k-1 was already used for a different request');

    expect(alert.textContent).toMatch(/already used for a different request/);
  });

  it('says the order is gone on a not found', async () => {
    const alert = await refusal(404, 'Not found');

    expect(alert.textContent).toMatch(/no longer available/i);
  });

  it('does not mark the order confirmed when the server fails unexpectedly', async () => {
    await refusal(500, 'Internal Server Error');

    // Still a draft, still numbered as the fixture had it, and the action still offered.
    expect(screen.getByText('SO-2026-0055')).toBeDefined();
    expect(screen.getByRole('button', { name: /confirm order/i })).toBeDefined();
  });

  it('does not mark the order confirmed when the request never arrives', async () => {
    stubFetchWith((input) => {
      if (input === CONFIRM_URL) return Promise.reject(new TypeError('Failed to fetch'));

      return Promise.resolve(
        new Response(JSON.stringify(SELLER), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    mount();
    await waitForPage();

    fireEvent.click(confirmButton());

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/check your connection/i);
    expect(screen.getByText('SO-2026-0055')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 13. The placeholder this increment supersedes.
// ---------------------------------------------------------------------------

describe('the fixture placeholder', () => {
  it('is gone, so the action is no longer a disabled promise', async () => {
    // What this increment actually replaced. There was never a fixture function for confirming;
    // the placeholder was a permanently disabled button titled "Write actions arrive with the
    // backend". A button that cannot be pressed is exactly the fake functionality the project
    // rules forbid, and this asserts it did not survive.
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    const button = confirmButton() as HTMLButtonElement;

    expect(button.disabled).toBe(false);
    expect(button.title).not.toMatch(/arrive with the backend/i);
  });

  it('reaches the network rather than the fixture layer', async () => {
    // The order still comes from fixtures and the confirmation does not. This is the per module
    // removal of section 16.1 rather than a broad cleanup.
    renderPage(SELLER, () => ({ status: 200, body: CONFIRMED }));
    await waitForPage();

    fireEvent.click(confirmButton());

    await waitFor(() => expect(confirmCalls()).toHaveLength(1));
    expect(confirmCalls()[0]?.url).toBe(CONFIRM_URL);
  });
});
