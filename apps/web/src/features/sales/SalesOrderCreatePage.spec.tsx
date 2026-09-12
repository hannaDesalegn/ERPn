/**
 * Creating a sales order draft from the interface.
 *
 * WHAT THESE PROVE. That the form offers real master data rather than fixtures, that it sends the
 * server exactly the fields the contract accepts and nothing else, that one idempotency key covers
 * a submission and its retries, and that the identifier it navigates to is the server's.
 *
 * WHAT THEY DELIBERATELY DO NOT PROVE. Anything about pricing, totals or tax. None of that is
 * decided here, there is no field for it and no figure on the screen, so a test asserting one
 * would be inventing the very thing the form refuses to do.
 *
 * `fetch` is stubbed per test and records every call, so an assertion can be about what was sent
 * rather than only about what was rendered.
 */

import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionGate } from '@/app/SessionGate';
import { SessionProvider } from '@/app/session';
import { Protected } from '@/app/Protected';
import type { Me } from '@/services/session.service';
import { SalesOrderCreatePage } from './SalesOrderCreatePage';

const CREATE_PATH = '/api/sales-orders';

const SELLER: Me = {
  user: { id: 'u-1', email: 'sam@example.test', name: 'Sam Seller' },
  companies: [{ id: 'c-1', name: 'North Trading', isActive: true }],
  activeCompany: { id: 'c-1', name: 'North Trading' },
  roles: [{ key: 'sales', name: 'Sales' }],
  permissions: ['sales:view', 'sales:create', 'customers:view', 'inventory:view'],
};

/** Signed in, in the same company, and unable to create. */
const CLERK: Me = { ...SELLER, permissions: ['sales:view'] };

const CUSTOMERS = [
  { id: 'cust-1', code: 'C-1', name: 'North Supply', status: 'active' },
  { id: 'cust-2', code: 'C-2', name: 'South Supply', status: 'active' },
  { id: 'cust-old', code: 'C-9', name: 'Retired Supply', status: 'archived' },
];

const WAREHOUSES = [
  { id: 'wh-1', code: 'WH-1', name: 'Main depot', status: 'active', isDefault: true },
  { id: 'wh-2', code: 'WH-2', name: 'Overflow', status: 'active', isDefault: false },
];

const PRODUCTS = [
  { id: 'p-1', sku: 'SKU-W', name: 'Widget', type: 'stockable', stockingUom: 'unit', status: 'active' },
  { id: 'p-2', sku: 'SKU-G', name: 'Gadget', type: 'stockable', stockingUom: 'unit', status: 'active' },
];

/** What the server answers with. Its identifier is the one navigation must use. */
const CREATED = {
  id: '33333333-3333-4333-8333-333333333333',
  docNumber: null,
  status: 'draft',
  orderDate: '2026-09-12',
  expectedDeliveryDate: null,
  currency: 'USD',
  customer: { id: 'cust-1', name: 'North Supply' },
  warehouse: { id: 'wh-1', name: 'Main depot' },
  salesRep: null,
  subtotal: '30.0000',
  taxTotal: '0.0000',
  total: '30.0000',
  version: 1,
  lines: [],
};

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

/** Reports the identifier the router arrived at, standing in for the detail page. */
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
          <MemoryRouter initialEntries={['/sales/orders/new']}>
            <Routes>
              <Route
                path="/sales/orders/new"
                element={
                  <Protected permission="sales:create">
                    <SalesOrderCreatePage />
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

/** Serves the three master data reads, and whatever the test wants the create to answer. */
function renderForm(
  create: () => { status: number; body?: unknown } = () => ({ status: 201, body: CREATED }),
  me: Me = SELLER,
) {
  stubFetch((url, method) => {
    if (url.startsWith('/api/customers')) return { status: 200, body: CUSTOMERS };
    if (url.startsWith('/api/warehouses')) return { status: 200, body: WAREHOUSES };
    if (url.startsWith('/api/products')) return { status: 200, body: PRODUCTS };
    if (url.startsWith(CREATE_PATH) && method === 'POST') return create();
    return { status: 200, body: me };
  });

  return mount();
}

const createCalls = () => calls.filter((call) => call.method === 'POST');

const waitForForm = () =>
  waitFor(() => expect(screen.getByRole('button', { name: /create draft/i })).toBeDefined());

/** Fills the header and the first line with something the server would accept. */
async function fillValidOrder() {
  await waitFor(() =>
    expect(screen.getByLabelText('Customer').querySelectorAll('option').length).toBeGreaterThan(1),
  );

  fireEvent.change(screen.getByLabelText('Customer'), { target: { value: 'cust-1' } });
  fireEvent.change(screen.getByLabelText('Order date'), { target: { value: '2026-09-12' } });
  fireEvent.change(screen.getByLabelText('Product on line 1'), { target: { value: 'p-1' } });
  fireEvent.change(screen.getByLabelText('Quantity on line 1'), { target: { value: '3' } });
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /create draft/i }));

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The pickers.
// ---------------------------------------------------------------------------

describe('what the form offers', () => {
  it('renders the header fields and one line', async () => {
    renderForm();
    await waitForForm();

    expect(screen.getByLabelText('Customer')).toBeDefined();
    expect(screen.getByLabelText('Warehouse')).toBeDefined();
    expect(screen.getByLabelText('Order date')).toBeDefined();
    expect(screen.getByLabelText('Expected delivery')).toBeDefined();
    expect(screen.getByLabelText('Product on line 1')).toBeDefined();
  });

  it('loads customers, warehouses and products from the real endpoints', async () => {
    renderForm();
    await waitForForm();

    await waitFor(() => expect(screen.getByText(/North Supply/)).toBeDefined());
    expect(calls.some((call) => call.url === '/api/customers')).toBe(true);
    expect(calls.some((call) => call.url === '/api/warehouses')).toBe(true);
    expect(calls.some((call) => call.url === '/api/products')).toBe(true);
  });

  it('offers no archived record, which the server would refuse anyway', async () => {
    renderForm();
    await waitForForm();

    await waitFor(() => expect(screen.getByText(/North Supply/)).toBeDefined());
    expect(screen.queryByText(/Retired Supply/)).toBeNull();
  });

  it('preselects the default warehouse', async () => {
    renderForm();
    await waitForForm();

    const warehouse = screen.getByLabelText('Warehouse') as HTMLSelectElement;
    await waitFor(() => expect(warehouse.value).toBe('wh-1'));
  });

  it('has no field for anything the server decides', async () => {
    // The strongest form of section 3.3 on this screen: not refused, unrepresentable.
    renderForm();
    await waitForForm();

    for (const absent of [/price/i, /total/i, /tax/i, /document number/i, /status/i]) {
      expect(screen.queryByLabelText(absent)).toBeNull();
    }
  });

  it('offers no sales representative, which has no read surface', async () => {
    renderForm();
    await waitForForm();

    expect(screen.queryByLabelText(/representative|sales rep/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lines.
// ---------------------------------------------------------------------------

describe('lines', () => {
  it('adds and removes them', async () => {
    renderForm();
    await waitForForm();

    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    expect(screen.getByLabelText('Product on line 2')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /remove line 2/i }));
    expect(screen.queryByLabelText('Product on line 2')).toBeNull();
  });

  it('will not remove the last one, because an order needs a line', async () => {
    renderForm();
    await waitForForm();

    const remove = screen.getByRole('button', { name: /remove line 1/i }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation, which is usability rather than authority.
// ---------------------------------------------------------------------------

describe('before it will submit', () => {
  it('sends nothing when the required fields are empty', async () => {
    renderForm();
    await waitForForm();

    submit();

    await waitFor(() => expect(screen.getByText('A customer is required')).toBeDefined());
    expect(createCalls()).toHaveLength(0);
  });

  it.each(['0', '-2', ''])('refuses a quantity of %s', async (quantity) => {
    renderForm();
    await waitForForm();
    await fillValidOrder();

    fireEvent.change(screen.getByLabelText('Quantity on line 1'), { target: { value: quantity } });
    submit();

    await waitFor(() => expect(screen.getByText('More than zero')).toBeDefined());
    expect(createCalls()).toHaveLength(0);
  });

  it('refuses a discount outside nought to a hundred', async () => {
    renderForm();
    await waitForForm();
    await fillValidOrder();

    fireEvent.change(screen.getByLabelText('Discount on line 1'), { target: { value: '120' } });
    submit();

    await waitFor(() => expect(screen.getByText('Between 0 and 100')).toBeDefined());
    expect(createCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The request.
// ---------------------------------------------------------------------------

describe('what it sends', () => {
  it('posts exactly the fields the contract accepts', async () => {
    renderForm();
    await waitForForm();
    await fillValidOrder();

    submit();

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0]?.body).toEqual({
      customerId: 'cust-1',
      warehouseId: 'wh-1',
      orderDate: '2026-09-12',
      lines: [{ productId: 'p-1', quantity: '3' }],
    });
  });

  it('sends quantities and discounts as strings, exactly as typed', async () => {
    // Section 4.3 keeps six decimal places. A number would have lost the sixth before this.
    renderForm();
    await waitForForm();
    await fillValidOrder();

    fireEvent.change(screen.getByLabelText('Quantity on line 1'), {
      target: { value: '2.500000' },
    });
    fireEvent.change(screen.getByLabelText('Discount on line 1'), { target: { value: '12.5' } });
    submit();

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = createCalls()[0]?.body as { lines: { quantity: string; discountPercent: string }[] };
    expect(body.lines[0]?.quantity).toBe('2.500000');
    expect(body.lines[0]?.discountPercent).toBe('12.5');
  });

  it('sends several lines in the order they were entered', async () => {
    renderForm();
    await waitForForm();
    await fillValidOrder();

    fireEvent.click(screen.getByRole('button', { name: /add line/i }));
    fireEvent.change(screen.getByLabelText('Product on line 2'), { target: { value: 'p-2' } });
    fireEvent.change(screen.getByLabelText('Quantity on line 2'), { target: { value: '7' } });
    submit();

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    const body = createCalls()[0]?.body as { lines: { productId: string }[] };
    expect(body.lines.map((line) => line.productId)).toEqual(['p-1', 'p-2']);
  });

  it('carries an idempotency key', async () => {
    renderForm();
    await waitForForm();
    await fillValidOrder();

    submit();

    await waitFor(() => expect(createCalls()).toHaveLength(1));
    expect(createCalls()[0]?.headers['Idempotency-Key']).toMatch(/.+/);
  });

  it('reuses that key when the same submission is retried', async () => {
    // Section 11: one key per intent, not per attempt. A fresh key on the retry would make it a
    // second order rather than the same one arriving again.
    let attempt = 0;
    renderForm(() => {
      attempt += 1;
      return attempt === 1
        ? { status: 500, body: { message: 'boom' } }
        : { status: 201, body: CREATED };
    });
    await waitForForm();
    await fillValidOrder();

    submit();
    await waitFor(() => expect(createCalls()).toHaveLength(1));

    submit();
    await waitFor(() => expect(createCalls()).toHaveLength(2));

    const keys = createCalls().map((call) => call.headers['Idempotency-Key']);
    expect(keys[0]).toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------
// What happens after.
// ---------------------------------------------------------------------------

describe('after the server answers', () => {
  it('navigates to the identifier the server returned', async () => {
    renderForm();
    await waitForForm();
    await fillValidOrder();

    submit();

    await waitFor(() => expect(screen.getByTestId('landed')).toBeDefined());
    expect(screen.getByTestId('landed').textContent).toBe(CREATED.id);
  });

  it('shows a pending state and will not submit twice', async () => {
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({
          url: input,
          method,
          headers: { ...((init?.headers ?? {}) as Record<string, string>) },
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });

        if (input.startsWith(CREATE_PATH) && method === 'POST') {
          await held;
          return new Response(JSON.stringify(CREATED), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }

        const body = input.startsWith('/api/customers')
          ? CUSTOMERS
          : input.startsWith('/api/warehouses')
            ? WAREHOUSES
            : input.startsWith('/api/products')
              ? PRODUCTS
              : SELLER;

        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    mount();
    await waitForForm();
    await fillValidOrder();

    submit();

    const pending = await waitFor(
      () => screen.getByRole('button', { name: /creating/i }) as HTMLButtonElement,
    );
    expect(pending.disabled).toBe(true);

    fireEvent.click(pending);
    expect(createCalls()).toHaveLength(1);

    release();
    await waitFor(() => expect(screen.getByTestId('landed')).toBeDefined());
  });

  it('shows what the server said when it refuses the order', async () => {
    renderForm(() => ({
      status: 422,
      body: { message: 'Customer not found', statusCode: 422 },
    }));
    await waitForForm();
    await fillValidOrder();

    submit();

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/Customer not found/);
    expect(screen.queryByTestId('landed')).toBeNull();
  });

  it('explains a permission refusal without repeating the bare word', async () => {
    renderForm(() => ({ status: 403, body: { message: 'Forbidden' } }));
    await waitForForm();
    await fillValidOrder();

    submit();

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/do not have permission/i);
  });

  it('shows an idempotency conflict as the conflict it is', async () => {
    renderForm(() => ({
      status: 409,
      body: { message: 'The idempotency key k-1 was already used for a different request' },
    }));
    await waitForForm();
    await fillValidOrder();

    submit();

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).toMatch(/already used for a different request/);
  });

  it('leaks no database vocabulary on an unexpected failure', async () => {
    renderForm(() => ({ status: 500, body: { message: 'relation sales_orders does not exist' } }));
    await waitForForm();
    await fillValidOrder();

    submit();

    const alert = await waitFor(() => screen.getByRole('alert'));
    expect(alert.textContent).not.toMatch(/sales_orders|relation/i);
    expect(screen.queryByTestId('landed')).toBeNull();
  });

  it('does not navigate when the request never arrives', async () => {
    renderForm(() => {
      throw new TypeError('Failed to fetch');
    });
    await waitForForm();
    await fillValidOrder();

    submit();

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.queryByTestId('landed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Permission.
// ---------------------------------------------------------------------------

describe('permission', () => {
  it('refuses the screen to someone without sales:create', async () => {
    // The same guard every other route uses. It is not the authorization boundary: the endpoint
    // refuses the same request whatever this drew, which the backend tests prove separately.
    renderForm(() => ({ status: 201, body: CREATED }), CLERK);

    await waitFor(() => expect(screen.queryByRole('button', { name: /create draft/i })).toBeNull());
    expect(createCalls()).toHaveLength(0);
  });
});
