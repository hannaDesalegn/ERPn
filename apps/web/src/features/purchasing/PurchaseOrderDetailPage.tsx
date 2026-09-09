/**
 * Purchase order detail.
 *
 * Mirrors the sales order screen, plus the two controls that only exist on the
 * buying side:
 *
 * APPROVAL. Raising an order and approving it are separate permissions held by
 * different people. That is segregation of duties: the officer who chooses a
 * supplier should not also be the person who authorises paying them.
 *
 * THREE-WAY MATCH. Before a supplier is paid, three documents must agree on
 * quantity and price: what we ordered, what arrived, and what we were charged.
 * The line table below shows ordered against received so a discrepancy is
 * visible on the order itself rather than only at payment time.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Icon, PageHeader } from '@/components/ui';
import { MoneyText } from '@/components/domain/MoneyText';
import {
  DocumentLifecycle,
  PURCHASE_ORDER_STEPS,
  lifecycleStep,
} from '@/components/domain/documents';
import {
  DetailGrid,
  DetailSkeleton,
  DetailTitle,
  HistoryPanel,
  RelatedPanel,
  TotalsBlock,
} from '@/components/domain/detail';
import { useSession } from '@/app/session';
import { cn, formatDate, formatDateTime, formatQuantity } from '@/lib/format';

export function PurchaseOrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useSession();

  const order = useQuery({
    queryKey: queryKeys.purchaseOrder(id),
    queryFn: () => api.purchasing.getOrder(id),
  });

  const supplier = useQuery({
    queryKey: queryKeys.supplier(order.data?.supplier.id ?? ''),
    queryFn: () => api.parties.getSupplier(order.data!.supplier.id),
    enabled: Boolean(order.data?.supplier.id),
  });

  if (order.isError) return <ErrorState message={(order.error as Error).message} />;
  if (order.isLoading || !order.data) return <DetailSkeleton />;

  const po = order.data;
  const awaitingApproval = po.status === 'pending_approval';
  const isCancelled = po.status === 'cancelled';
  const isDraft = po.status === 'draft';

  const totalOrdered = po.lines.reduce((a, l) => a + l.quantity, 0);
  const totalReceived = po.lines.reduce((a, l) => a + l.receivedQuantity, 0);
  const hasShortfall = po.lines.some(
    (l) => l.receivedQuantity > 0 && l.receivedQuantity < l.quantity,
  );

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/purchasing/orders"
            backLabel="Back to purchase orders"
            docNumber={po.docNumber}
            status={po.status}
          />
        }
        subtitle={`${po.supplier.name} · raised ${formatDate(po.orderDate)} by ${po.requestedBy.name}`}
        meta={
          <DocumentLifecycle
            steps={PURCHASE_ORDER_STEPS}
            current={lifecycleStep(po.status)}
            cancelled={isCancelled}
          />
        }
        actions={
          <>
            {/*
              Approval is gated on the permission AND the state. A purchasing
              officer viewing an order awaiting approval sees no approve button
              at all, because approving their own order is the control this
              exists to prevent.
            */}
            {awaitingApproval && can('purchasing:approve') && (
              <Button variant="primary" icon="check" disabled title="Write actions arrive with the backend">
                Approve order
              </Button>
            )}
            {awaitingApproval && !can('purchasing:approve') && (
              <Badge tone="warning">Awaiting manager approval</Badge>
            )}
            {po.status === 'approved' && can('inventory:move') && (
              <Button icon="box" disabled title="Records what physically arrived and moves stock">
                Receive goods
              </Button>
            )}
            {isDraft && can('purchasing:create') && (
              <Button variant="primary" icon="arrowRight" disabled title="Submits the order for approval">
                Submit for approval
              </Button>
            )}
          </>
        }
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Order details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Supplier">
                  <Link
                    to={`/purchasing/suppliers/${po.supplier.id}`}
                    className="text-accent-text hover:underline"
                  >
                    {po.supplier.name}
                  </Link>
                </Field>
                <Field label="Order date">{formatDate(po.orderDate)}</Field>
                <Field label="Expected">{formatDate(po.expectedDate)}</Field>
                <Field label="Deliver to">{po.warehouseName}</Field>
                <Field label="Raised by">{po.requestedBy.name}</Field>
                <Field label="Approved by">{po.approvedBy?.name}</Field>
                <Field label="Approved at">{formatDateTime(po.approvedAt)}</Field>
                <Field label="Received">
                  <span className="tabular">
                    {formatQuantity(totalReceived)} / {formatQuantity(totalOrdered)}
                  </span>
                </Field>
              </dl>
            </Card>

            <Card padded={false}>
              <CardHeader title="Line items" subtitle={`${po.lines.length} lines`} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                      <th className="px-3 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-right">Ordered</th>
                      <th className="px-3 py-2 text-right">Received</th>
                      <th className="hidden px-3 py-2 text-right sm:table-cell">Billed</th>
                      <th className="px-3 py-2 text-right">Unit cost</th>
                      <th className="hidden px-3 py-2 text-right lg:table-cell">Tax</th>
                      <th className="px-3 py-2 text-right">Line total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.lines.map((line) => {
                      const short = line.receivedQuantity > 0 && line.receivedQuantity < line.quantity;
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
                          <td className="px-3 py-2 text-right tabular">
                            <span className={cn(short ? 'font-medium text-warning-text' : 'text-secondary')}>
                              {formatQuantity(line.receivedQuantity)}
                            </span>
                          </td>
                          <td className="hidden px-3 py-2 text-right tabular sm:table-cell">
                            <span className="text-secondary">{formatQuantity(line.billedQuantity)}</span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <MoneyText value={line.unitCost} />
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

              <TotalsBlock subtotal={po.subtotal} taxTotal={po.taxTotal} total={po.total} />
            </Card>
          </>
        }
        aside={
          <>
            {/* Three-way match state, surfaced on the order itself. */}
            <Card padded={false}>
              <CardHeader title="Three-way match" />
              <ul className="divide-y divide-[var(--border)] text-sm">
                <MatchRow label="Ordered" value={formatQuantity(totalOrdered)} done />
                <MatchRow
                  label="Received"
                  value={totalReceived > 0 ? formatQuantity(totalReceived) : 'Nothing yet'}
                  done={totalReceived >= totalOrdered}
                  warn={hasShortfall}
                />
                <MatchRow
                  label="Billed"
                  value={po.billedTotal.amount > 0 ? undefined : 'No bill received'}
                  money={po.billedTotal.amount > 0 ? po.billedTotal : undefined}
                  done={po.billedTotal.amount > 0}
                />
              </ul>
              <p className="border-t border-line px-4 py-2.5 text-xs text-muted">
                {hasShortfall
                  ? 'Quantities differ between the order and the receipt. Resolve before paying.'
                  : 'A supplier bill should only be paid once all three agree.'}
              </p>
            </Card>

            <RelatedPanel links={po.links} />

            <Card padded={false}>
              <CardHeader
                title="Supplier"
                action={
                  <Link
                    to={`/purchasing/suppliers/${po.supplier.id}`}
                    className="text-xs text-accent-text hover:underline"
                  >
                    Open
                  </Link>
                }
              />
              {supplier.data && (
                <div className="space-y-2 p-4 text-sm">
                  <p className="font-medium text-primary">{supplier.data.name}</p>
                  <div className="flex justify-between">
                    <span className="text-secondary">Currently owed</span>
                    <MoneyText value={supplier.data.balance} strong />
                  </div>
                  <div className="flex justify-between">
                    <span className="text-secondary">Terms</span>
                    <span>{supplier.data.paymentTerms.label}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-secondary">Lead time</span>
                    <span>{supplier.data.leadTimeDays} days</span>
                  </div>
                </div>
              )}
            </Card>

            <HistoryPanel targetId={po.id} />

            {po.status === 'billed' && (
              <Card>
                <p className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted uppercase">
                  <Icon name="ledger" className="size-3" />
                  Accounting effect
                </p>
                <p className="mt-1.5 text-xs text-secondary">
                  Receiving the goods increased{' '}
                  <span className="font-medium text-primary">Inventory</span>. Posting the supplier
                  bill credited <span className="font-medium text-primary">Accounts Payable</span>,
                  creating the obligation to pay.
                </p>
              </Card>
            )}
          </>
        }
      />
    </>
  );
}

function MatchRow({
  label,
  value,
  money,
  done,
  warn,
}: {
  label: string;
  value?: string;
  money?: { amount: number; currency: 'USD' | 'EUR' | 'ETB' };
  done?: boolean;
  warn?: boolean;
}) {
  return (
    <li className="flex items-center gap-2 px-4 py-2.5">
      <span
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full',
          warn
            ? 'bg-warning-soft text-warning-text'
            : done
              ? 'bg-success-soft text-success-text'
              : 'bg-neutral-soft text-neutral-text',
        )}
      >
        <Icon name={warn ? 'alert' : done ? 'check' : 'clock'} className="size-3" />
      </span>
      <span className="flex-1 text-secondary">{label}</span>
      {money ? (
        <MoneyText value={money} strong />
      ) : (
        <span className={cn('tabular', done ? 'font-medium text-primary' : 'text-muted')}>{value}</span>
      )}
    </li>
  );
}
