/**
 * Editing a sales order draft from the interface.
 *
 * WHAT MATTERS HERE that did not matter for creating. The form starts from an order rather than
 * empty, the request carries the version that order was read at, and a version conflict has to
 * become a state a person can act on. Section 10.1 asks for the last of those in so many words:
 * the frontend surfaces a conflict as a real, explained state, not a generic error.
 *
 * `fetch` is stubbed per test and records every call, so an assertion can be about what was sent.
 */

import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionGate } from '@/app/SessionGate';
import { SessionProvider } from '@/app/session';
import { Protected } from '@/app/Protected';
import type { Me } from '@/services/session.service';
import { SalesOrderEditPage } from './SalesOrderEditPage';

const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const ORDER_PATH = `/api/sales-orders/${ORDER_ID}`;

const SELLER: Me = {
  user: { id: 'u-1', email: 'sam@example.test', name: 'Sam Seller' },
  companies: [{ id: 'c-1', name: 'North Trading', isActive: true }],
  activeCompany: { id: 'c-1', name: 'North Trading' },
  roles: [{ key: 'sales', name: 'Sales' }],
  permissions: ['sales:view', 'sales:create', 'customers:view', 'inventory:view'],
};

const CUSTOMERS = [
  { id: 'cust-1', code: 'C-1', name: 'North Supply', status: 'active' },
  { id: 'cust-2', code: 'C-2', name: 'South Supply', status: 'active' },
];
const WAREHOUSES = [
  { id: 'wh-1', code: 'WH-1', name: 'Main depot', status: 'active', isDefault: true },
  { id: 'wh-2', code: 'WH-2', name: 'Overflow', status: 'active', isDefault: false },
];
const PRODUCTS = [
  { id: 'p-1', sku: 'SKU-W', name: 'Widget', type: 'stockable', stockingUom: 'unit', status: 'active' },
  { id: 'p-2', sku: 'SKU-G', name: 'Gadget', type: 'stockable', stockingUom: 'unit', status: 'active' },
];

/** The draft being edited, as the detail endpoint serves it. */
const DRAFT = {
  id: ORDER_ID,
  docNumber: null,
  status: 'draft',
  orderDate: '2026-09-11',
  expectedDeliveryDate: '2026-09-20',
  currency: 'USD',
  customer: { id: 'cust-2', name: 'South Supply' },
  warehouse: { id: 'wh-2', name: 'Overflow' },
  salesRep: null,
  subtotal: '20.0000',
  taxTotal: '0.0000',
  total: '20.0000',
  version: 3,
  lines: [
    {
      id: 'line-1',
      lineNumber: 1,
      productId: 'p-2',
      productSku: 'SKU-G',
      productName: 'Gadget',
      quantity: '5.000000',
      unitPrice: '4.000000',
      discountPercent: '0.000000',
      taxRatePercent: '0.000000',
      lineSubtotal: '20.0000',
      lineTax: '0.0000',
      lineTotal: '20.0000',
      deliveredQuantity: '0.000000',
      invoicedQuantity: '0.000000',
    },
  ],
};

/** What the server answers with after a successful save. */
const SAVED = { ...DRAFT, version: 4 };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];

function stubFetch(answer: (url: string, method: string) => { status: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: input,
        method,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });

      const { status, body } = answer(input, method);
      return Promise.resolve(
        new Response(body === undefined ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

function Landed() {
  const { id } = useParams();
  return <div data-testid="landed">{id}</div>;
}

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <SessionGate>
          <MemoryRouter initialEntries={[`/sales/orders/${ORDER_ID}/edit`]}>
            <Routes>
              <Route
                path="/sales/orders/:id/edit"
                element={
                  <Protected permission="sales:create">
                    <SalesOrderEditPage />
                  </Protected>
                }
              />
              <Route path="/sales/orders/:id" element={<Landed />} />
            </Routes>
          </MemoryRouter>
        </SessionGate>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

function renderEdit(
  save: () => { status: number; body?: unknown } = () => ({ status: 200, body: SAVED }),
  order: unknown = DRAFT,
) {
  stubFetch((url, method) => {
    if (url.startsWith('/api/customers')) return { status: 200, body: CUSTOMERS };
    if (url.startsWith('/api/warehouses')) return { status: 200, body: WAREHOUSES };
    if (url.startsWith('/api/products')) return { status: 200, body: PRODUCTS };
    if (url === ORDER_PATH && method === 'PUT') return save();
    if (url === ORDER_PATH) return { status: 200, body: order };
    return { status: 200, body: SELLER };
  });

  return mount();
}

const saveCalls = () => calls.filter((call) => call.method === 'PUT');

/**
 * Waits for the form and for its pickers to have loaded.
 *
 * A select whose value names an option that has not arrived yet reports an empty string, so an
 * assertion about the prefill made too early passes for the wrong reason or fails for one.
 */
const waitForForm = async () => {
  await waitFor(() => expect(screen.getByRole('button', { name: /save changes/i })).toBeDefined());
  await waitFor(() =>
    expect(screen.getByLabelText('Customer').querySelectorAll('option').length).toBeGreaterThan(1),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText('Product on line 1').querySelectorAll('option').length,
    ).toBeGreaterThan(1),
  );
};

const save = () => fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the form it opens with', () => {
  it('starts from the order rather than empty', async () => {
    renderEdit();
    await waitForForm();

    expect((screen.getByLabelText('Customer') as HTMLSelectElement).value).toBe('cust-2');
    expect((screen.getByLabelText('Warehouse') as HTMLSelectElement).value).toBe('wh-2');
    expect((screen.getByLabelText('Order date') as HTMLInputElement).value).toBe('2026-09-11');
  });

  it('does not overwrite the order with the default warehouse', async () => {
    // The draft ships from the overflow depot. Preselecting the default over it would silently
    // change where a saved order ships from.
    renderEdit();
    await waitForForm();

    expect((screen.getByLabelText('Warehouse') as HTMLSelectElement).value).not.toBe('wh-1');
  });

  it('starts from the lines the order has', async () => {
    renderEdit();
    await waitForForm();

    expect((screen.getByLabelText('Product on line 1') as HTMLSelectElement).value).toBe('p-2');
    expect((screen.getByLabelText('Quantity on line 1') as HTMLInputElement).value).toBe('5');
  });

  it('reads the order from the real endpoint', async () => {
    renderEdit();
    await waitForForm();

    expect(calls.some((call) => call.url === ORDER_PATH && call.method === 'GET')).toBe(true);
  });
});

describe('what it sends', () => {
  it('puts the edited order with the version it was read at', async () => {
    renderEdit();
    await waitForForm();

    fireEvent.change(screen.getByLabelText('Quantity on line 1'), { target: { value: '9' } });
    save();

    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    expect(saveCalls()[0]?.body).toEqual({
      customerId: 'cust-2',
      warehouseId: 'wh-2',
      orderDate: '2026-09-11',
      expectedDeliveryDate: '2026-09-20',
      lines: [{ productId: 'p-2', quantity: '9' }],
      version: 3,
    });
  });

  it('sends an untouched order back unchanged', async () => {
    renderEdit();
    await waitForForm();

    save();

    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    const body = saveCalls()[0]?.body as { lines: { quantity: string }[] };
    expect(body.lines[0]?.quantity).toBe('5');
  });

  it('carries an idempotency key and reuses it on a retry', async () => {
    let attempt = 0;
    renderEdit(() => {
      attempt += 1;
      return attempt === 1
        ? { status: 500, body: { message: 'boom' } }
        : { status: 200, body: SAVED };
    });
    await waitForForm();

    save();
    await waitFor(() => expect(saveCalls()).toHaveLength(1));
    save();
    await waitFor(() => expect(saveCalls()).toHaveLength(2));

    const keys = saveCalls().map((call) => call.headers['Idempotency-Key']);
    expect(keys[0]).toMatch(/.+/);
    expect(keys[0]).toBe(keys[1]);
  });

  it('sends nothing when a line is emptied', async () => {
    renderEdit();
    await waitForForm();

    fireEvent.change(screen.getByLabelText('Quantity on line 1'), { target: { value: '0' } });
    save();

    await waitFor(() => expect(screen.getByText('More than zero')).toBeDefined());
    expect(saveCalls()).toHaveLength(0);
  });
});

describe('after the server answers', () => {
  it('returns to the order it saved', async () => {
    renderEdit();
    await waitForForm();

    save();

    await waitFor(() => expect(screen.getByTestId('landed')).toBeDefined());
    expect(screen.getByTestId('landed').textContent).toBe(ORDER_ID);
  });

  it('shows what the server said when it refuses', async () => {
    renderEdit(() => ({ status: 422, body: { message: 'Customer not found' } }));
    await waitForForm();

    save();

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/Customer not found/);
    expect(screen.queryByTestId('landed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Section 10.1's explained conflict.
// ---------------------------------------------------------------------------

describe('when somebody else changed the order first', () => {
  const CURRENT = {
    ...DRAFT,
    version: 5,
    orderDate: '2026-09-15',
    lines: [DRAFT.lines[0], { ...DRAFT.lines[0], id: 'line-2', lineNumber: 2 }],
  };

  const conflicted = () =>
    renderEdit(() => ({
      status: 409,
      body: {
        statusCode: 409,
        message: `Sales order ${ORDER_ID} was modified by someone else. Re-read it and try again.`,
        current: CURRENT,
      },
    }));

  it('explains what happened rather than showing a generic error', async () => {
    conflicted();
    await waitForForm();

    save();

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/was edited while you were working on it/i);
    expect(alert.textContent).toMatch(/Nothing you entered has been applied/i);
  });

  it('describes the order as it now stands, from the refusal body', async () => {
    // The endpoint sends the current order precisely so this screen does not fetch it and end up
    // describing a third state.
    conflicted();
    await waitForForm();

    save();

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/2 lines/);
    expect(alert.textContent).toMatch(/2026-09-15/);
  });

  it('offers a way back to the current order', async () => {
    conflicted();
    await waitForForm();

    save();

    const open = await waitFor(() => screen.getByRole('button', { name: /open the current order/i }));
    fireEvent.click(open);

    await waitFor(() => expect(screen.getByTestId('landed')).toBeDefined());
  });

  it('stops showing the form, so nothing is resubmitted blind', async () => {
    conflicted();
    await waitForForm();

    save();

    await waitFor(() => expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull());
    expect(saveCalls()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What cannot be edited.
// ---------------------------------------------------------------------------

describe('an order that is not a draft', () => {
  it('is explained rather than offered as a form', async () => {
    // Section 12.2: only a draft is editable. Reached by typing the URL, since nothing links here.
    renderEdit(undefined, { ...DRAFT, status: 'confirmed', docNumber: 'SO-0001' });

    await waitFor(() => expect(screen.getByText(/cannot be edited/i)).toBeDefined());
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
    expect(saveCalls()).toHaveLength(0);
  });
});

describe('permission', () => {
  it('refuses the screen without sales:create', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/customers')) return { status: 200, body: CUSTOMERS };
      if (url.startsWith('/api/warehouses')) return { status: 200, body: WAREHOUSES };
      if (url.startsWith('/api/products')) return { status: 200, body: PRODUCTS };
      if (url === ORDER_PATH) return { status: 200, body: DRAFT };
      return { status: 200, body: { ...SELLER, permissions: ['sales:view'] } };
    });
    mount();

    await waitFor(() => expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull());
    expect(saveCalls()).toHaveLength(0);
  });
});
