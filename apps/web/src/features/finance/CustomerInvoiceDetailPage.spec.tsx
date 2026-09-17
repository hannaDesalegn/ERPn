/**
 * The customer invoice screen, reading the backend.
 *
 * `fetch` is stubbed per test and records every call, so assertions can be about which endpoint
 * was reached and what was sent as well as what was drawn. The session comes from a real `/me`
 * response through the real provider, because the permission gates are part of what is exercised.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionGate } from '@/app/SessionGate';
import { SessionProvider } from '@/app/session';
import type { Me } from '@/services/session.service';
import { CustomerInvoiceDetailPage } from './CustomerInvoiceDetailPage';
import pageSource from './CustomerInvoiceDetailPage.tsx?raw';

const INVOICE = 'inv-1';
const INVOICE_URL = `/api/customer-invoices/${INVOICE}`;

/** A draft as the backend serves it: no number, figures as decimal strings. */
const DRAFT_INVOICE = {
  id: INVOICE,
  docNumber: null,
  status: 'draft',
  invoiceDate: '2026-09-17',
  dueDate: null,
  currency: 'USD',
  customer: { id: 'cust-1', name: 'Harbor Office Supplies', taxRegistrationNumber: 'US-11-2233445' },
  subtotal: '245.0000',
  taxTotal: '0.0000',
  total: '245.0000',
  version: 1,
  salesOrders: [{ id: 'so-1', docNumber: 'SO-0001' }],
  lines: [
    {
      id: 'line-1',
      lineNumber: 1,
      sourceSalesOrderId: 'so-1',
      sourceSalesOrderLineId: 'sol-1',
      productId: 'p-1',
      productSku: 'SKU-1001',
      productName: 'Copy paper A4 80gsm, box of 5 reams',
      quantity: '10.000000',
      unitPrice: '24.500000',
      discountPercent: '0.000000',
      taxRatePercent: '0.000000',
      lineSubtotal: '245.0000',
      lineTax: '0.0000',
      lineTotal: '245.0000',
    },
  ],
};

const ACCOUNTANT: Me = {
  user: { id: 'u-3', email: 'alex@example.test', name: 'Alex Accountant' },
  companies: [{ id: 'c-1', name: 'East', isActive: true }],
  activeCompany: { id: 'c-1', name: 'East' },
  roles: [{ key: 'accountant', name: 'Accountant' }],
  permissions: ['invoices:view', 'invoices:create', 'invoices:post', 'accounting:view', 'audit:view'],
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = () => { status: number; body?: unknown };

/** Installs a fetch that answers from a table of routes and records every call into `calls`. */
function stubFetch(calls: Call[], routes: Record<string, Handler>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: input,
        method,
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: init?.body ?? undefined,
      });

      const handler = routes[`${method} ${input}`];
      if (!handler) {
        return Promise.resolve(
          new Response(JSON.stringify({ statusCode: 404, message: 'Not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }

      const { status, body } = handler();
      return Promise.resolve(
        body === undefined
          ? new Response(null, { status })
          : new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
      );
    }),
  );
}

function mountInvoice() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <SessionGate>
          <MemoryRouter initialEntries={[`/sales/invoices/${INVOICE}`]}>
            <Routes>
              <Route path="/sales/invoices/:id" element={<CustomerInvoiceDetailPage />} />
            </Routes>
          </MemoryRouter>
        </SessionGate>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

let calls: Call[] = [];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the invoice it shows', () => {
  it('renders the draft the server sent, with no number', async () => {
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({ status: 200, body: DRAFT_INVOICE }),
    });
    mountInvoice();

    await waitFor(() => expect(screen.getByText('Draft invoice')).toBeDefined());
    expect(screen.getAllByText('Harbor Office Supplies').length).toBeGreaterThan(0);
    expect(screen.getByText('US-11-2233445')).toBeDefined();
    expect(screen.getByText('Copy paper A4 80gsm, box of 5 reams')).toBeDefined();
    expect(screen.getAllByText('SO-0001').length).toBeGreaterThan(0);
    expect(screen.getByText(INVOICE)).toBeDefined();
    // The total the server computed, and nothing about payment, which the backend does not have.
    expect(screen.getAllByText('$245.00').length).toBeGreaterThan(0);
    expect(screen.queryByText(/outstanding/i)).toBeNull();
    expect(screen.queryByText(/balance due/i)).toBeNull();
  });

  it('shows the number the server allocated once posted', async () => {
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({
        status: 200,
        body: { ...DRAFT_INVOICE, status: 'posted', docNumber: 'INV-0001', version: 2 },
      }),
    });
    mountInvoice();

    await waitFor(() => expect(screen.getByText('INV-0001')).toBeDefined());
    expect(screen.getByText('Posted')).toBeDefined();
    expect(screen.queryByText('Draft invoice')).toBeNull();
  });

  it('says the invoice is unavailable when the server answers not found', async () => {
    // Another company's invoice and a missing one answer alike, per section 6.1, so the screen
    // cannot and does not say which.
    stubFetch(calls, { 'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }) });
    mountInvoice();

    await waitFor(() =>
      expect(screen.getByText('That record is no longer available.')).toBeDefined(),
    );
  });

  it('reads the invoice from the backend and never from fixtures', () => {
    // Read from the source, because a fixture read makes no request to observe.
    expect(pageSource).not.toMatch(/from '@\/mocks/);
    expect(pageSource).not.toMatch(/api\.finance\b/);
    expect(pageSource).toMatch(/api\.invoices\.getInvoice/);
  });
});

// ---------------------------------------------------------------------------
// Posting.
// ---------------------------------------------------------------------------

describe('the post invoice action', () => {
  const POST_URL = `${INVOICE_URL}/post`;
  const POSTED_INVOICE = { ...DRAFT_INVOICE, status: 'posted', docNumber: 'INV-0001', version: 2 };
  const POSTING = {
    id: INVOICE,
    status: 'posted',
    docNumber: 'INV-0001',
    journalEntryId: 'je-1',
    total: '245.0000',
    currency: 'USD',
  };

  /** Signed in with invoices:view and no posting authority, as the demo sales account is. */
  const SALES: Me = {
    ...ACCOUNTANT,
    user: { id: 'u-2', email: 'sam@example.test', name: 'Sam Sales' },
    roles: [{ key: 'sales', name: 'Sales Representative' }],
    permissions: ['sales:view', 'sales:create', 'sales:confirm', 'invoices:view'],
  };

  const postButton = () => screen.queryByRole('button', { name: /post invoice/i });
  const postCalls = () => calls.filter((call) => call.url === POST_URL);

  /** The invoice read answers draft until a posting succeeds, then whatever `afterPosting` says. */
  function renderWith(
    me: Me,
    post: Handler,
    afterPosting: Handler = () => ({ status: 200, body: POSTED_INVOICE }),
  ) {
    let posted = false;
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: me }),
      [`GET ${INVOICE_URL}`]: () => (posted ? afterPosting() : { status: 200, body: DRAFT_INVOICE }),
      [`POST ${POST_URL}`]: () => {
        const answer = post();
        if (answer.status === 200) posted = true;
        return answer;
      },
    });
    return mountInvoice();
  }

  const waitForDraft = () => waitFor(() => expect(screen.getByText('Draft invoice')).toBeDefined());

  it('is offered on a draft to someone holding invoices:post', async () => {
    renderWith(ACCOUNTANT, () => ({ status: 200, body: POSTING }));
    await waitForDraft();

    expect(postButton()).not.toBeNull();
  });

  it('is not offered to a salesperson, who may read the invoice and not post it', async () => {
    renderWith(SALES, () => ({ status: 200, body: POSTING }));
    await waitForDraft();

    expect(postButton()).toBeNull();
  });

  it('is not offered on an invoice that is already posted', async () => {
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({ status: 200, body: POSTED_INVOICE }),
    });
    mountInvoice();

    await waitFor(() => expect(screen.getByText('INV-0001')).toBeDefined());
    expect(postButton()).toBeNull();
  });

  it('posts with a key and no body, then shows the number and status read back', async () => {
    renderWith(ACCOUNTANT, () => ({ status: 200, body: POSTING }));
    await waitForDraft();

    fireEvent.click(postButton()!);

    await waitFor(() => expect(screen.getByText('INV-0001')).toBeDefined());
    expect(postCalls()).toHaveLength(1);
    expect(postCalls()[0]?.method).toBe('POST');
    expect(postCalls()[0]?.headers['Idempotency-Key']).toMatch(/.+/);
    expect(postCalls()[0]?.body).toBeUndefined();
    expect(screen.getByText('Posted')).toBeDefined();
    expect(screen.queryByText('Draft invoice')).toBeNull();
    expect(postButton()).toBeNull();
    // Read again after posting, rather than trusting the posting response alone.
    await waitFor(() =>
      expect(calls.filter((call) => call.url === INVOICE_URL).length).toBeGreaterThanOrEqual(2),
    );
  });

  it('keeps the posted number on screen if the read after posting fails', async () => {
    renderWith(
      ACCOUNTANT,
      () => ({ status: 200, body: POSTING }),
      () => ({ status: 500, body: { statusCode: 500, message: 'Internal server error' } }),
    );
    await waitForDraft();

    fireEvent.click(postButton()!);

    await waitFor(() => expect(screen.getByText('INV-0001')).toBeDefined());
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/could not be reloaded/),
    );
    expect(screen.queryByText('Draft invoice')).toBeNull();
    expect(postButton()).toBeNull();
  });

  it.each([
    ['quantity_exceeded', 'That sales order line no longer has enough left to invoice'],
    [
      'tax_rate_changed',
      'This invoice was raised at 10.000000 per cent tax and the company now charges 12.000000. Re-read the draft and post it again.',
    ],
    ['nothing_to_post', 'This invoice comes to nothing, so there is no entry to post'],
  ])('shows the %s refusal as the server wrote it and leaves the draft a draft', async (_r, message) => {
    renderWith(ACCOUNTANT, () => ({ status: 422, body: { statusCode: 422, message } }));
    await waitForDraft();

    fireEvent.click(postButton()!);

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
    expect(screen.getByRole('alert').textContent).toContain('This invoice cannot be posted');
    expect(screen.getByText('Draft invoice')).toBeDefined();
  });

  it('explains a 403 rather than repeating the word forbidden', async () => {
    renderWith(ACCOUNTANT, () => ({ status: 403, body: { statusCode: 403, message: 'Forbidden' } }));
    await waitForDraft();

    fireEvent.click(postButton()!);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'You do not have permission to post invoices in this company.',
      ),
    );
  });

  it('reloads the invoice on a 409, and shows it as it now stands', async () => {
    // Someone else posted it first: the posting is refused and the read now answers posted.
    let refused = false;
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({
        status: 200,
        body: refused ? POSTED_INVOICE : DRAFT_INVOICE,
      }),
      [`POST ${POST_URL}`]: () => {
        refused = true;
        return {
          status: 409,
          body: { statusCode: 409, message: 'A customer invoice cannot move from posted to posted' },
        };
      },
    });
    mountInvoice();
    await waitForDraft();

    fireEvent.click(postButton()!);

    await waitFor(() => expect(screen.getByText('INV-0001')).toBeDefined());
    expect(screen.getByRole('alert').textContent).toContain('The invoice has changed');
  });

  it('carries the same key when the person tries again after a refusal', async () => {
    renderWith(ACCOUNTANT, () => ({ status: 422, body: { statusCode: 422, message: 'Not now' } }));
    await waitForDraft();

    fireEvent.click(postButton()!);
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    await waitFor(() => expect((postButton() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(postButton()!);
    await waitFor(() => expect(postCalls()).toHaveLength(2));

    expect(postCalls()[1]?.headers['Idempotency-Key']).toBe(
      postCalls()[0]?.headers['Idempotency-Key'],
    );
  });
});

// ---------------------------------------------------------------------------
// What a posting left behind.
// ---------------------------------------------------------------------------

describe('the journal and history panels', () => {
  const JOURNAL_URL = `${INVOICE_URL}/journal`;
  const AUDIT_URL = `${INVOICE_URL}/audit-events`;
  const POSTED_INVOICE = { ...DRAFT_INVOICE, status: 'posted', docNumber: 'INV-0001', version: 2 };

  /** The entry the server wrote for this invoice, at no tax, so two lines. */
  const ENTRY = {
    id: 'je-1',
    entryDate: '2026-09-17',
    memo: 'Customer invoice INV-0001',
    currency: 'USD',
    recordedAt: '2026-09-17T10:00:00.000Z',
    lines: [
      {
        lineNumber: 1,
        account: { id: 'a-1', code: '1200', name: 'Accounts Receivable', type: 'asset' },
        debit: '245.0000',
        credit: '0.0000',
        currency: 'USD',
      },
      {
        lineNumber: 2,
        account: { id: 'a-3', code: '4000', name: 'Sales Revenue', type: 'revenue' },
        debit: '0.0000',
        credit: '245.0000',
        currency: 'USD',
      },
    ],
  };

  const POSTED_EVENT = {
    id: 'ev-1',
    occurredAt: '2026-09-17T10:00:00.000Z',
    action: 'customer_invoice_posted',
    summary: 'Posted customer invoice INV-0001 for 245.0000 USD',
    actor: { id: 'u-3', name: 'Alex Accountant' },
    actorRoles: ['accountant'],
  };

  const SALES: Me = {
    ...ACCOUNTANT,
    roles: [{ key: 'sales', name: 'Sales Representative' }],
    permissions: ['sales:view', 'invoices:view'],
  };

  const refused = { status: 403, body: { statusCode: 403, message: 'Forbidden' } };

  it('shows the entry the posting wrote, account by account', async () => {
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({ status: 200, body: POSTED_INVOICE }),
      [`GET ${JOURNAL_URL}`]: () => ({ status: 200, body: [ENTRY] }),
      [`GET ${AUDIT_URL}`]: () => ({ status: 200, body: [POSTED_EVENT] }),
    });
    mountInvoice();

    await waitFor(() => expect(screen.getByText('Customer invoice INV-0001')).toBeDefined());
    expect(screen.getByText('Accounts Receivable')).toBeDefined();
    expect(screen.getByText('1200')).toBeDefined();
    expect(screen.getByText('Sales Revenue')).toBeDefined();
    expect(screen.getByText('je-1')).toBeDefined();
  });

  it('shows who posted it, with the role they held and the amount recorded', async () => {
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({ status: 200, body: POSTED_INVOICE }),
      [`GET ${JOURNAL_URL}`]: () => ({ status: 200, body: [ENTRY] }),
      [`GET ${AUDIT_URL}`]: () => ({ status: 200, body: [POSTED_EVENT] }),
    });
    mountInvoice();

    await waitFor(() =>
      expect(screen.getByText('Posted customer invoice INV-0001 for 245.0000 USD')).toBeDefined(),
    );
    expect(screen.getByText('Alex Accountant')).toBeDefined();
    expect(screen.getByText('Accountant')).toBeDefined();
  });

  it('says a draft has posted nothing and has no history yet', async () => {
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({ status: 200, body: DRAFT_INVOICE }),
      [`GET ${JOURNAL_URL}`]: () => ({ status: 200, body: [] }),
      [`GET ${AUDIT_URL}`]: () => ({ status: 200, body: [] }),
    });
    mountInvoice();

    await waitFor(() =>
      expect(screen.getByText('Nothing reaches the ledger until this invoice is posted.')).toBeDefined(),
    );
    expect(screen.getByText('History begins when this invoice is posted.')).toBeDefined();
  });

  it('tells a person without the capabilities so, rather than showing an empty panel', async () => {
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: SALES }),
      [`GET ${INVOICE_URL}`]: () => ({ status: 200, body: POSTED_INVOICE }),
      [`GET ${JOURNAL_URL}`]: () => refused,
      [`GET ${AUDIT_URL}`]: () => refused,
    });
    mountInvoice();

    await waitFor(() =>
      expect(screen.getByText('You do not have permission to view the journal.')).toBeDefined(),
    );
    expect(screen.getByText('You do not have permission to view this history.')).toBeDefined();
    expect(screen.queryByText('Accounts Receivable')).toBeNull();
  });

  it('reads both panels again after posting, so the new entry and record appear', async () => {
    let posted = false;
    stubFetch(calls, {
      'GET /api/me': () => ({ status: 200, body: ACCOUNTANT }),
      [`GET ${INVOICE_URL}`]: () => ({
        status: 200,
        body: posted ? POSTED_INVOICE : DRAFT_INVOICE,
      }),
      [`GET ${JOURNAL_URL}`]: () => ({ status: 200, body: posted ? [ENTRY] : [] }),
      [`GET ${AUDIT_URL}`]: () => ({ status: 200, body: posted ? [POSTED_EVENT] : [] }),
      [`POST ${INVOICE_URL}/post`]: () => {
        posted = true;
        return {
          status: 200,
          body: {
            id: INVOICE,
            status: 'posted',
            docNumber: 'INV-0001',
            journalEntryId: 'je-1',
            total: '245.0000',
            currency: 'USD',
          },
        };
      },
    });
    mountInvoice();
    // Both panels have already answered for the draft, so what follows can only come from reading
    // them again. Clicking before they answer would let their first read see the posting.
    await waitFor(() =>
      expect(screen.getByText('Nothing reaches the ledger until this invoice is posted.')).toBeDefined(),
    );
    await waitFor(() =>
      expect(screen.getByText('History begins when this invoice is posted.')).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: /post invoice/i }));

    await waitFor(() => expect(screen.getByText('Accounts Receivable')).toBeDefined());
    await waitFor(() =>
      expect(screen.getByText('Posted customer invoice INV-0001 for 245.0000 USD')).toBeDefined(),
    );
  });

  it('reads the journal and the trail through the invoice service only', () => {
    expect(pageSource).toMatch(/api\.invoices\.journal/);
    expect(pageSource).toMatch(/api\.invoices\.auditTrail/);
    expect(pageSource).not.toMatch(/api\.admin\b/);
  });
});
