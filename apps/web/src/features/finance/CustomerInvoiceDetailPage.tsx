/**
 * Customer invoice detail, from the backend.
 *
 * Follows the sales order screen's shape: identity and status in the header, the document on the
 * left, its connections on the right.
 *
 * EVERYTHING ON IT IS THE SERVER'S. The number, the status, the lines and every figure arrive in
 * the invoice response. Nothing is computed here, and nothing is shown that the response does not
 * carry: there is no paid amount, balance due or payment state, because the backend has no
 * payments, and a zero in those places would be a claim about the customer.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { CustomerInvoiceDetail } from '@/services/invoices.service';
import { Card, CardHeader, ErrorState, Field, PageHeader } from '@/components/ui';
import { MoneyText } from '@/components/domain/MoneyText';
import { DetailGrid, DetailSkeleton, DetailTitle } from '@/components/domain/detail';
import { formatDate, formatQuantity } from '@/lib/format';
import { refusalText } from '@/features/sales/refusalText';

export function CustomerInvoiceDetailPage() {
  const { id = '' } = useParams();

  const invoice = useQuery({
    queryKey: queryKeys.invoice(id),
    queryFn: () => api.invoices.getInvoice(id),
  });

  if (invoice.isError) return <ErrorState message={refusalText(invoice.error)} />;
  if (invoice.isLoading || !invoice.data) return <DetailSkeleton />;

  const inv = invoice.data;
  // Back to the order it was raised from, because the invoice list is still sample data and an
  // invoice reached from a real order belongs beside that order.
  const firstOrder = inv.salesOrders[0];

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo={firstOrder ? `/sales/orders/${firstOrder.id}` : '/sales/orders'}
            backLabel={firstOrder ? 'Back to the sales order' : 'Back to sales orders'}
            // A draft has no number: the posting transaction allocates one, per section 10.4.
            docNumber={inv.docNumber ?? 'Draft invoice'}
            status={inv.status}
          />
        }
        subtitle={`${inv.customer.name} · invoice date ${formatDate(inv.invoiceDate)}`}
      />

      <DetailGrid
        main={
          <>
            <InvoiceDetails invoice={inv} />
            <InvoiceLines invoice={inv} />
          </>
        }
        aside={null}
      />
    </>
  );
}

function InvoiceDetails({ invoice }: { invoice: CustomerInvoiceDetail }) {
  return (
    <Card padded={false}>
      <CardHeader title="Invoice details" />
      <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        {/* Plain text rather than a link: the customer screens still show sample data, and a
            link from a real document into them would land on a record that is not this one. */}
        <Field label="Customer">{invoice.customer.name}</Field>
        <Field label="Customer tax number">{invoice.customer.taxRegistrationNumber}</Field>
        <Field label="Invoice date">{formatDate(invoice.invoiceDate)}</Field>
        <Field label="Due date">{formatDate(invoice.dueDate)}</Field>
        <Field label="Currency">{invoice.currency}</Field>
        <Field label="Sales orders">
          <span className="flex flex-wrap gap-x-2">
            {invoice.salesOrders.map((order) => (
              <Link
                key={order.id}
                to={`/sales/orders/${order.id}`}
                className="text-accent-text hover:underline"
              >
                {order.docNumber ?? 'Draft order'}
              </Link>
            ))}
          </span>
        </Field>
        <Field label="Invoice ID">
          <span className="font-mono text-xs break-all text-secondary">{invoice.id}</span>
        </Field>
      </dl>
    </Card>
  );
}

function InvoiceLines({ invoice }: { invoice: CustomerInvoiceDetail }) {
  const orderNumber = new Map(invoice.salesOrders.map((order) => [order.id, order.docNumber]));

  return (
    <Card padded={false}>
      <CardHeader title="Line items" subtitle={`${invoice.lines.length} lines`} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
              <th className="px-3 py-2 text-left">Product</th>
              <th className="hidden px-3 py-2 text-left sm:table-cell">Order</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Unit price</th>
              <th className="hidden px-3 py-2 text-right md:table-cell">Disc.</th>
              <th className="hidden px-3 py-2 text-right lg:table-cell">Tax</th>
              <th className="px-3 py-2 text-right">Line total</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id} className="border-b border-line">
                <td className="px-3 py-2">
                  <span className="block truncate font-medium text-primary">{line.productName}</span>
                  <span className="text-xs text-muted">{line.productSku}</span>
                </td>
                <td className="hidden px-3 py-2 sm:table-cell">
                  <Link
                    to={`/sales/orders/${line.sourceSalesOrderId}`}
                    className="text-accent-text hover:underline"
                  >
                    {orderNumber.get(line.sourceSalesOrderId) ?? 'Draft order'}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right tabular">{formatQuantity(line.quantity)}</td>
                <td className="px-3 py-2 text-right">
                  <MoneyText value={line.unitPrice} />
                </td>
                <td className="hidden px-3 py-2 text-right tabular md:table-cell">
                  {/* No discount leaves the cell empty, as on the sales order. */}
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
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end border-t border-line bg-sunken/50 px-3 py-3">
        <dl className="w-full max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-secondary">Subtotal</dt>
            <dd>
              <MoneyText value={invoice.subtotal} />
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-secondary">Tax</dt>
            <dd>
              <MoneyText value={invoice.taxTotal} muted />
            </dd>
          </div>
          <div className="flex justify-between border-t border-line pt-1 text-base font-semibold">
            <dt>Total</dt>
            <dd>
              <MoneyText value={invoice.total} strong />
            </dd>
          </div>
        </dl>
      </div>
    </Card>
  );
}
