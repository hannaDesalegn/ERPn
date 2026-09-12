/**
 * Sales order detail — the reference implementation for every document screen.
 *
 * LAYOUT PATTERN (reuse this for POs, invoices, bills):
 *   header      identity, status, lifecycle position, permitted actions
 *   left 2/3    the document itself: parties, dates, line items, totals
 *   right 1/3   its CONNECTIONS: related documents, audit history, context
 *
 * The right column is what distinguishes an ERP from a form. A sales order is
 * not an island — it reserved stock, produced a delivery, generated an invoice,
 * and that invoice hit the ledger. Showing that chain in place means a user can
 * answer "did this get shipped and did they pay" without hunting through four
 * other screens.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import { ApiError } from '@/services/client';
import type { SalesOrder } from '@/domain';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Field,
  Icon,
  PageHeader,
  Skeleton,
} from '@/components/ui';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import {
  ActivityTimeline,
  DocumentLifecycle,
  RelatedDocuments,
  SALES_ORDER_STEPS,
  lifecycleStep,
} from '@/components/domain/documents';
import { useSession } from '@/app/session';
import { cn, formatDate, formatQuantity } from '@/lib/format';
import { formatMoney } from '@/lib/money';

export function SalesOrderDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const queryClient = useQueryClient();

  /**
   * One idempotency key per intent, not per attempt.
   *
   * Contract section 11 is explicit about this: pressing the button once produces one key however
   * many times the request is transmitted. So the key is made when this order is opened and reused
   * by every retry, which is what lets the server tell a repeated intent from a new one. Making a
   * fresh key inside the click handler would turn each retry into a new intent and defeat the
   * mechanism the backend just built.
   *
   * Adjusted during render rather than in an effect, which is React's documented way to reset
   * state when a prop changes: navigating to a different order is a different intent.
   */
  const [intent, setIntent] = useState(() => ({ orderId: id, key: newIdempotencyKey() }));
  if (intent.orderId !== id) setIntent({ orderId: id, key: newIdempotencyKey() });

  const order = useQuery({
    queryKey: queryKeys.salesOrder(id),
    queryFn: () => api.sales.getOrder(id),
  });

  const auditTrail = useQuery({
    queryKey: queryKeys.auditForDocument(id),
    queryFn: () => api.admin.auditForDocument(id),
  });

  /**
   * Confirming, which is the first write this application makes for real.
   *
   * Everything that decides the outcome happens on the server: the transition is checked against
   * its table, the capability is re-read, every line is reserved under a row lock, the number is
   * allocated and the audit record written, all in one transaction. None of that is repeated
   * here, and the button being visible decides nothing, per section 6.7.
   */
  const confirmation = useMutation({
    mutationFn: () => api.sales.confirmOrder(id, intent.key),
    onSuccess: (result) => {
      // From the server's answer, never worked out locally. The document number in particular is
      // section 10.4's to issue, and a number invented here would be a second one.
      queryClient.setQueryData<SalesOrder>(queryKeys.salesOrder(id), (current) =>
        current ? { ...current, status: result.status as SalesOrder['status'], docNumber: result.docNumber } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditForDocument(id) });
    },
  });

  const customer = useQuery({
    queryKey: queryKeys.customer(order.data?.customer.id ?? ''),
    queryFn: () => api.parties.getCustomer(order.data!.customer.id),
    enabled: Boolean(order.data?.customer.id),
  });

  if (order.isError) {
    return (
      <ErrorState
        message={(order.error as Error).message}
        onRetry={() => navigate('/sales/orders')}
      />
    );
  }

  if (order.isLoading || !order.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 rounded-lg" />
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-96 rounded-lg lg:col-span-2" />
          <Skeleton className="h-96 rounded-lg" />
        </div>
      </div>
    );
  }

  const so = order.data;
  const isDraft = so.status === 'draft';
  const isCancelled = so.status === 'cancelled';
  const totalOrdered = so.lines.reduce((a, l) => a + l.quantity, 0);
  const totalDelivered = so.lines.reduce((a, l) => a + l.deliveredQuantity, 0);
  const creditUsedPct = customer.data
    ? (customer.data.balance.amount / Math.max(1, customer.data.creditLimit.amount)) * 100
    : 0;

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link to="/sales/orders" className="text-muted hover:text-primary" aria-label="Back to sales orders">
              <Icon name="chevronLeft" className="size-4" />
            </Link>
            {so.docNumber}
            <StatusBadge status={so.status} />
          </span>
        }
        subtitle={
          <>
            {so.customer.name} · ordered {formatDate(so.orderDate)} · {so.salesRep.name}
          </>
        }
        meta={
          <DocumentLifecycle
            steps={SALES_ORDER_STEPS}
            current={lifecycleStep(so.status)}
            cancelled={isCancelled}
          />
        }
        actions={
          <>
            {/*
              ACTION VISIBILITY.
              Actions are gated on BOTH permission and document state. A confirmed
              order cannot be confirmed again, and a salesperson cannot post an
              invoice. Buttons are disabled with an explanatory title where the
              user could plausibly expect them to work, so the UI teaches the
              workflow rather than just refusing.
            */}
            {can('sales:confirm') && isDraft && (
              <Button
                variant="primary"
                icon="check"
                onClick={() => confirmation.mutate()}
                disabled={confirmation.isPending}
                title="Reserves stock, allocates the document number and records the confirmation"
              >
                {confirmation.isPending ? 'Confirming...' : 'Confirm order'}
              </Button>
            )}
            {can('sales:view') && !isDraft && !isCancelled && (
              <Button icon="truck" disabled title="Creates a delivery and reserves stock">
                Create delivery
              </Button>
            )}
            {can('invoices:create') && so.status === 'delivered' && (
              <Button icon="invoice" disabled title="Raises a customer invoice for the delivered quantity">
                Create invoice
              </Button>
            )}
            {can('sales:cancel') && !isCancelled && (
              <Button variant="danger" icon="close" disabled title="Cancelling releases reserved stock">
                Cancel
              </Button>
            )}
          </>
        }
      />

      {confirmation.isError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-line-strong bg-danger-soft px-3 py-2"
        >
          <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-danger" />
          <p className="text-sm text-primary">{refusalText(confirmation.error)}</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* ---------------- Document body ---------------- */}
        <div className="space-y-4 lg:col-span-2">
          <Card padded={false}>
            <CardHeader title="Order details" />
            <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
              <Field label="Customer">
                <Link
                  to={`/sales/customers/${so.customer.id}`}
                  className="text-accent-text hover:underline"
                >
                  {so.customer.name}
                </Link>
              </Field>
              <Field label="Order date">{formatDate(so.orderDate)}</Field>
              <Field label="Expected delivery">{formatDate(so.expectedDeliveryDate)}</Field>
              <Field label="Warehouse">{so.warehouseName}</Field>
              <Field label="Sales rep">{so.salesRep.name}</Field>
              <Field label="Payment terms">
                {customer.data?.paymentTerms.label ?? <Skeleton className="h-4 w-16" />}
              </Field>
              <Field label="Currency">{so.currency}</Field>
              <Field label="Fulfilment">
                <span className="tabular">
                  {formatQuantity(totalDelivered)} / {formatQuantity(totalOrdered)}
                </span>
              </Field>
            </dl>
          </Card>

          {/* ---- Line items ---- */}
          <Card padded={false}>
            <CardHeader
              title="Line items"
              subtitle={`${so.lines.length} lines`}
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                    <th className="px-3 py-2 text-left">Product</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="hidden px-3 py-2 text-right sm:table-cell">Delivered</th>
                    <th className="px-3 py-2 text-right">Unit price</th>
                    <th className="hidden px-3 py-2 text-right md:table-cell">Disc.</th>
                    <th className="hidden px-3 py-2 text-right lg:table-cell">Tax</th>
                    <th className="px-3 py-2 text-right">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {so.lines.map((line) => {
                    const shortfall = line.quantity - line.deliveredQuantity;
                    return (
                      <tr key={line.id} className="border-b border-line">
                        <td className="px-3 py-2">
                          <Link
                            to={`/inventory/products/${line.productId}`}
                            className="block truncate font-medium text-primary hover:text-accent-text hover:underline"
                          >
                            {line.productName}
                          </Link>
                          <span className="text-xs text-muted">{line.productSku}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular">{formatQuantity(line.quantity)}</td>
                        <td className="hidden px-3 py-2 text-right tabular sm:table-cell">
                          <span
                            className={cn(
                              shortfall > 0 && !isDraft && !isCancelled
                                ? 'text-warning-text'
                                : 'text-secondary',
                            )}
                          >
                            {formatQuantity(line.deliveredQuantity)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <MoneyText value={line.unitPrice} />
                        </td>
                        <td className="hidden px-3 py-2 text-right tabular md:table-cell">
                          {/* No discount leaves the cell empty. Printing "0%" on
                              every undiscounted line is noise, and blank in a
                              discount column is unambiguous. */}
                          {line.discountPercent > 0 && (
                            <span className="text-secondary">{line.discountPercent}%</span>
                          )}
                        </td>
                        <td className="hidden px-3 py-2 text-right lg:table-cell">
                          <MoneyText value={line.lineTax} muted />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <MoneyText value={line.lineTotal} strong />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Totals. Tax is shown separately because it is collected on behalf
                of the tax authority and is never the company's revenue. */}
            <div className="flex justify-end border-t border-line bg-sunken/50 px-3 py-3">
              <dl className="w-full max-w-xs space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-secondary">Subtotal</dt>
                  <dd>
                    <MoneyText value={so.subtotal} />
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-secondary">VAT</dt>
                  <dd>
                    <MoneyText value={so.taxTotal} muted />
                  </dd>
                </div>
                <div className="flex justify-between border-t border-line pt-1 text-base font-semibold">
                  <dt>Total</dt>
                  <dd>
                    <MoneyText value={so.total} strong />
                  </dd>
                </div>
                {so.invoicedTotal.amount > 0 && (
                  <div className="flex justify-between pt-1 text-xs">
                    <dt className="text-muted">Invoiced</dt>
                    <dd>
                      <MoneyText value={so.invoicedTotal} muted />
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </Card>

          {so.notes && (
            <Card>
              <p className="text-2xs font-medium tracking-wide text-muted uppercase">Notes</p>
              <p className="mt-1 text-sm text-secondary">{so.notes}</p>
            </Card>
          )}
        </div>

        {/* ---------------- Connections ---------------- */}
        <div className="space-y-4">
          {/*
            THE TRACEABILITY PANEL.
            Every document produced by, or that produced, this order.
          */}
          <Card padded={false}>
            <CardHeader
              title="Related documents"
              action={<Icon name="link" className="size-3.5 text-muted" />}
            />
            <RelatedDocuments links={so.links} />
          </Card>

          {/* Customer context — credit exposure is a sales decision, so it
              belongs on the order, not buried in the customer record. */}
          <Card padded={false}>
            <CardHeader
              title="Customer"
              action={
                <Link
                  to={`/sales/customers/${so.customer.id}`}
                  className="text-xs text-accent-text hover:underline"
                >
                  Open
                </Link>
              }
            />
            {customer.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-4" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : customer.data ? (
              <div className="space-y-3 p-4">
                <div>
                  <p className="text-sm font-medium text-primary">{customer.data.name}</p>
                  <p className="text-xs text-muted">
                    {customer.data.code} · {customer.data.address?.city}, {customer.data.address?.country}
                  </p>
                </div>

                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-secondary">Outstanding balance</dt>
                    <dd>
                      <MoneyText value={customer.data.balance} strong />
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-secondary">Credit limit</dt>
                    <dd>
                      <MoneyText value={customer.data.creditLimit} muted />
                    </dd>
                  </div>
                </dl>

                {/* Credit utilisation bar */}
                <div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        creditUsedPct > 100
                          ? 'bg-danger'
                          : creditUsedPct > 80
                            ? 'bg-warning'
                            : 'bg-success',
                      )}
                      style={{ width: `${Math.min(100, creditUsedPct)}%` }}
                    />
                  </div>
                  <p className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-muted">{creditUsedPct.toFixed(0)}% of credit used</span>
                    {creditUsedPct > 100 && <Badge tone="danger">Over limit</Badge>}
                  </p>
                </div>

                <p className="border-t border-line pt-2 text-xs text-muted">
                  Terms: {customer.data.paymentTerms.label} · invoices fall due{' '}
                  {customer.data.paymentTerms.daysUntilDue} days after issue
                </p>
              </div>
            ) : null}
          </Card>

          {/* Audit — who touched this document */}
          <Card padded={false}>
            <CardHeader title="History" />
            {auditTrail.isLoading ? (
              <div className="space-y-3 p-4">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            ) : (
              <ActivityTimeline events={auditTrail.data ?? []} />
            )}
          </Card>

          {/*
            ACCOUNTING CONSEQUENCE.
            Explains, in place, what posting did to the books. Teaching this at
            the point of use is far more effective than a separate help page,
            and it is why the UI must not present accounting as a total.
          */}
          {so.status === 'invoiced' && (
            <Card>
              <p className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted uppercase">
                <Icon name="ledger" className="size-3" />
                Accounting effect
              </p>
              <p className="mt-1.5 text-xs text-secondary">
                Invoicing this order debited{' '}
                <span className="font-medium text-primary">Accounts Receivable</span> by{' '}
                {formatMoney(so.total)} and credited{' '}
                <span className="font-medium text-primary">Product Sales</span>{' '}
                {formatMoney(so.subtotal)} plus{' '}
                <span className="font-medium text-primary">VAT Payable</span>{' '}
                {formatMoney(so.taxTotal)}. Shipping the goods separately moved their cost out of
                Inventory into Cost of Goods Sold.
              </p>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * A key for one confirmation intent.
 *
 * `crypto.randomUUID` where the browser has it, which is every browser this application supports
 * over HTTPS, and a random fallback where it does not. The value only has to be unique per
 * intent; it authenticates nothing and is never a secret.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * What to show when the server refuses a confirmation.
 *
 * The server's own words are used wherever it chose to explain: how much stock there actually
 * was, or which two states a transition was between. Where it deliberately says little, because
 * saying more would tell a caller about a record they may not see, this supplies a sentence that
 * is useful without adding anything the server did not.
 *
 * NO BUSINESS RULE IS DECIDED HERE. Every branch is about wording. The refusal already happened.
 */
function refusalText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'The order could not be confirmed. Check your connection and try again.';
  }

  if (error.status === 403) {
    return 'You do not have permission to confirm orders in this company.';
  }

  if (error.status === 404) {
    return 'This order is no longer available.';
  }

  if (error.status >= 500) {
    return 'The server could not complete the confirmation. Nothing was changed.';
  }

  return error.message;
}
