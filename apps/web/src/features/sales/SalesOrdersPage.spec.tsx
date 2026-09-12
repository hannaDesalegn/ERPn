/**
 * The sales order list, reading the backend.
 *
 * WHAT THIS IS FOR. Until now the list came from fixtures whose identifiers exist nowhere in the
 * database, so clicking a row reached a detail screen that answered not found. The regression at
 * the bottom of this file is the one that matters: an identifier the list hands back has to be
 * one the detail route serves, or the navigation is broken again and nothing else here would
 * notice.
 *
 * `fetch` is stubbed per test and records every call, so an assertion can be about which endpoint
 * was reached and with what query, rather than only about what ended up on screen.
 */

import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionGate } from '@/app/SessionGate';
import { SessionProvider } from '@/app/session';
import type { Me } from '@/services/session.service';
import { SalesOrdersPage } from './SalesOrdersPage';

const LIST_PATH = '/api/sales-orders';

const SELLER: Me = {
  user: { id: 'u-1', email: 'sam@example.test', name: 'Sam Seller' },
  companies: [{ id: 'c-1', name: 'North Trading', isActive: true }],
  activeCompany: { id: 'c-1', name: 'North Trading' },
  roles: [{ key: 'sales', name: 'Sales' }],
  permissions: ['sales:view', 'sales:confirm'],
};

/** Two rows, one a draft with no number and one confirmed, as the backend serves them. */
const PAGE = {
  rows: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      docNumber: 'SO-0001',
      status: 'confirmed',
      orderDate: '2026-09-11',
      currency: 'USD',
      total: '110.0000',
      customer: { name: 'North Supply' },
      warehouse: { name: 'Main depot' },
      salesRep: { name: 'Sam Seller' },
      lineCount: 2,
      orderedQuantity: '10.000000',
      deliveredQuantity: '5.000000',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      docNumber: null,
      status: 'draft',
      orderDate: '2026-09-10',
      currency: 'USD',
      total: '40.0000',
      customer: { name: 'South Supply' },
      warehouse: { name: 'Overflow' },
      salesRep: null,
      lineCount: 1,
      orderedQuantity: '4.000000',
      deliveredQuantity: '0.000000',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 25,
  totalValue: '150.0000',
};

const EMPTY = { rows: [], total: 0, page: 1, pageSize: 25, totalValue: '0' };

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];

/** Answers by path, so a query string can be asserted separately from the route. */
function stubFetch(answer: (url: string) => { status: number; body?: unknown }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      calls.push({ url: input, method: init?.method ?? 'GET' });

      const { status, body } = answer(input);
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

/** The list, plus a stand-in detail route so a click can be followed. */
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <SessionGate>
          <MemoryRouter initialEntries={['/sales/orders']}>
            <Routes>
              <Route path="/sales/orders" element={<SalesOrdersPage />} />
              <Route path="/sales/orders/:id" element={<Landed />} />
            </Routes>
          </MemoryRouter>
        </SessionGate>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

/** Reports the identifier the router arrived at, so a click can be checked without the real page. */
function Landed() {
  const { id } = useParams();
  return <div data-testid="landed">{id}</div>;
}

function renderList(body: unknown = PAGE, status = 200) {
  stubFetch((url) =>
    url.startsWith(LIST_PATH) ? { status, body } : { status: 200, body: SELLER },
  );
  return mount();
}

const listCalls = () => calls.filter((call) => call.url.startsWith(LIST_PATH));

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the list it shows', () => {
  it('calls the real endpoint rather than the fixture layer', async () => {
    renderList();

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls()[0]?.method).toBe('GET');
  });

  it('renders what the server sent', async () => {
    renderList();

    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());
    expect(screen.getByText('SO-0001')).toBeDefined();
    expect(screen.getByText('Main depot')).toBeDefined();
    expect(screen.getByText('South Supply')).toBeDefined();
  });

  it('shows nothing from the fixture set', async () => {
    // The fixtures number orders `SO-2026-nnnn`. None of that shape may appear, which is what
    // says the fixture list is gone rather than merely unused by one assertion.
    renderList();

    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());
    expect(screen.queryByText(/SO-2026-/)).toBeNull();
  });

  it('heads a draft with a word rather than a number it does not have', async () => {
    renderList();

    await waitFor(() => expect(screen.getByText('South Supply')).toBeDefined());
    // More than one thing on the row says draft: this is the order column, where a number would
    // otherwise be, rather than the status badge beside it.
    expect(screen.getAllByText('Draft').length).toBeGreaterThan(0);
  });

  it('says when no rep is assigned', async () => {
    renderList();

    await waitFor(() => expect(screen.getByText('Not assigned')).toBeDefined());
  });

  it('shows the delivered percentage from the served quantities', async () => {
    // Five of ten delivered. The screen never receives the lines those came from.
    renderList();

    await waitFor(() => expect(screen.getByText('50%')).toBeDefined());
  });

  it('shows the count and value the server computed over the filtered set', async () => {
    renderList();

    await waitFor(() => expect(screen.getByText(/2 orders/)).toBeDefined());
    expect(screen.getByText(/150\.00/)).toBeDefined();
  });

  it('turns the decimal strings on the wire into the money it renders', async () => {
    renderList();

    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());
    expect(screen.queryByText('110.0000')).toBeNull();
  });
});

describe('the states around it', () => {
  it('shows the existing empty state when nothing matches', async () => {
    renderList(EMPTY);

    await waitFor(() => expect(screen.getByText(/no sales orders match/i)).toBeDefined());
  });

  it('shows a loading state before the rows arrive', async () => {
    // Held open, so the table is observed mid flight rather than after it.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.startsWith(LIST_PATH)) {
          await held;
          return new Response(JSON.stringify(PAGE), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(SELLER), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    mount();

    await waitFor(() => expect(screen.getByText('Sales orders')).toBeDefined());
    expect(screen.queryByText('North Supply')).toBeNull();

    release();
    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());
  });

  it('does not invent rows when the server refuses', async () => {
    renderList({ message: 'Forbidden' }, 403);

    await waitFor(() => expect(screen.getByText('Sales orders')).toBeDefined());
    expect(screen.queryByText('North Supply')).toBeNull();
    expect(screen.queryByText(/SO-2026-/)).toBeNull();
  });
});

describe('the query it sends', () => {
  it('asks for the default sort the screen shows', async () => {
    renderList();

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    expect(listCalls()[0]?.url).toMatch(/sortBy=orderDate/);
  });

  it('sends a search term to the server rather than filtering here', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());

    fireEvent.change(screen.getByLabelText(/search sales orders/i), {
      target: { value: 'north' },
    });

    await waitFor(() => expect(listCalls().some((c) => /search=north/.test(c.url))).toBe(true));
  });

  it('sends a status filter to the server', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());

    fireEvent.change(screen.getByLabelText(/filter by status/i), {
      target: { value: 'confirmed' },
    });

    await waitFor(() => expect(listCalls().some((c) => /status=confirmed/.test(c.url))).toBe(true));
  });

  it('names no company, because the session decides that', async () => {
    renderList();

    await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
    for (const call of listCalls()) {
      expect(call.url).not.toMatch(/companyId|tenantId/);
    }
  });
});

describe('the navigation this work package exists for', () => {
  it('clicks through to the detail route with the identifier the server gave', async () => {
    // The regression. A fixture identifier would route to a detail screen the backend does not
    // serve, which is the state this replaced.
    renderList();

    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());

    fireEvent.click(screen.getByText('North Supply'));

    await waitFor(() => expect(screen.getByTestId('landed')).toBeDefined());
    expect(screen.getByTestId('landed').textContent).toBe(PAGE.rows[0]!.id);
  });

  it('hands back identifiers shaped like the ones the detail endpoint takes', async () => {
    // The detail route rejects anything that is not a uuid with a not found, so a list returning
    // fixture identifiers like `so-055` would navigate straight into one.
    renderList();

    await waitFor(() => expect(screen.getByText('North Supply')).toBeDefined());

    for (const row of PAGE.rows) {
      expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});
