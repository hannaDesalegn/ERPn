/**
 * Shared building blocks for document detail screens.
 *
 * Every detail page follows the same shape, established by the sales order
 * screen: identity and status in the header, the document body on the left, its
 * connections on the right. These pieces make that shape cheap to repeat so the
 * screens stay consistent, which matters more in an ERP than in most software:
 * a user who learns one document screen should already know the next one.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { DocumentRef, InvoiceLine, Money, PaymentAllocation } from '@/domain';
import { api, queryKeys } from '@/services';
import { Card, CardHeader, Icon, Skeleton } from '@/components/ui';
import { MoneyText } from './MoneyText';
import { StatusBadge } from './StatusBadge';
import { ActivityTimeline, DocumentLink, RelatedDocuments } from './documents';
import { formatQuantity } from '@/lib/format';

/** Title block with a back arrow and the document's status. */
export function DetailTitle({
  backTo,
  backLabel,
  docNumber,
  status,
}: {
  backTo: string;
  backLabel: string;
  docNumber: string;
  status?: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <Link to={backTo} className="text-muted hover:text-primary" aria-label={backLabel}>
        <Icon name="chevronLeft" className="size-4" />
      </Link>
      {docNumber}
      {status && <StatusBadge status={status} />}
    </span>
  );
}

/**
 * Invoice and bill line table. Both use `InvoiceLine`, so one component serves
 * customer invoices and supplier bills alike.
 */
export function InvoiceLinesTable({ lines }: { lines: InvoiceLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
            <th className="px-3 py-2 text-left">Description</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Unit price</th>
            <th className="hidden px-3 py-2 text-right md:table-cell">Disc.</th>
            <th className="hidden px-3 py-2 text-right lg:table-cell">Tax</th>
            <th className="hidden px-3 py-2 text-left xl:table-cell">Account</th>
            <th className="px-3 py-2 text-right">Line total</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-line">
              <td className="px-3 py-2">
                <span className="block truncate text-primary">{line.description}</span>
                {line.productSku && <span className="text-xs text-muted">{line.productSku}</span>}
              </td>
              <td className="px-3 py-2 text-right tabular">{formatQuantity(line.quantity)}</td>
              <td className="px-3 py-2 text-right">
                <MoneyText value={line.unitPrice} />
              </td>
              <td className="hidden px-3 py-2 text-right tabular md:table-cell">
                {line.discountPercent > 0 && (
                  <span className="text-secondary">{line.discountPercent}%</span>
                )}
              </td>
              <td className="hidden px-3 py-2 text-right lg:table-cell">
                <MoneyText value={line.lineTax} muted />
              </td>
              <td className="hidden px-3 py-2 text-left xl:table-cell">
                {/* The ledger account each line posts to. Present so the link
                    between a document and the books is visible on the document. */}
                {line.accountCode && (
                  <span className="text-xs text-muted tabular">{line.accountCode}</span>
                )}
              </td>
              <td className="px-3 py-2 text-right">
                <MoneyText value={line.lineTotal} strong />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Subtotal / tax / total block, with optional paid and outstanding rows. */
export function TotalsBlock({
  subtotal,
  taxTotal,
  total,
  paid,
  balanceDue,
  taxLabel = 'VAT',
}: {
  subtotal: Money;
  taxTotal: Money;
  total: Money;
  paid?: Money;
  balanceDue?: Money;
  taxLabel?: string;
}) {
  return (
    <div className="flex justify-end border-t border-line bg-sunken/50 px-3 py-3">
      <dl className="w-full max-w-xs space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-secondary">Subtotal</dt>
          <dd>
            <MoneyText value={subtotal} />
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-secondary">{taxLabel}</dt>
          <dd>
            <MoneyText value={taxTotal} muted />
          </dd>
        </div>
        <div className="flex justify-between border-t border-line pt-1 text-base font-semibold">
          <dt>Total</dt>
          <dd>
            <MoneyText value={total} strong />
          </dd>
        </div>
        {paid && (
          <div className="flex justify-between pt-1 text-xs">
            <dt className="text-muted">Paid</dt>
            <dd>
              <MoneyText value={paid} muted />
            </dd>
          </div>
        )}
        {balanceDue && (
          <div className="flex justify-between text-xs">
            <dt className="text-muted">Outstanding</dt>
            <dd>
              <MoneyText
                value={balanceDue}
                strong
                className={balanceDue.amount > 0 ? 'text-danger-text' : undefined}
              />
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

/** Related documents card. Present on every document screen. */
export function RelatedPanel({ links }: { links: DocumentRef[] }) {
  return (
    <Card padded={false}>
      <CardHeader title="Related documents" />
      <RelatedDocuments links={links} />
    </Card>
  );
}

/**
 * Audit history for one record. Fetches its own data so a detail page can drop
 * it in with only the document id.
 */
export function HistoryPanel({ targetId }: { targetId: string }) {
  const query = useQuery({
    queryKey: queryKeys.auditForDocument(targetId),
    queryFn: () => api.admin.auditForDocument(targetId),
  });

  return (
    <Card padded={false}>
      <CardHeader title="History" />
      {query.isLoading ? (
        <div className="space-y-3 p-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <ActivityTimeline events={query.data ?? []} />
      )}
    </Card>
  );
}

/** Payment allocation list. Shows how one payment settles which invoices. */
export function AllocationsPanel({
  allocations,
  unallocated,
}: {
  allocations: PaymentAllocation[];
  unallocated: Money;
}) {
  return (
    <Card padded={false}>
      <CardHeader title="Applied to" subtitle={`${allocations.length} invoices`} />
      {allocations.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted">
          Not yet matched to an invoice. The amount sits as a credit on the account.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--border)]">
          {allocations.map((allocation) => (
            <li key={allocation.invoiceId} className="flex items-center gap-2 px-4 py-2.5">
              <DocumentLink
                refDoc={{
                  id: allocation.invoiceId,
                  docType: 'customer_invoice',
                  docNumber: allocation.invoiceNumber,
                }}
                className="flex-1 text-sm"
              />
              <MoneyText value={allocation.amountApplied} strong className="text-sm" />
            </li>
          ))}
        </ul>
      )}
      {unallocated.amount > 0 && (
        <div className="flex items-center justify-between border-t border-line bg-warning-soft/40 px-4 py-2">
          <span className="text-xs font-medium text-warning-text">Unallocated</span>
          <MoneyText value={unallocated} strong className="text-sm text-warning-text" />
        </div>
      )}
    </Card>
  );
}

/** Two-column detail layout: document body left, connections right. */
export function DetailGrid({ main, aside }: { main: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">{main}</div>
      <div className="space-y-4">{aside}</div>
    </div>
  );
}

/** Consistent loading shape for a detail screen. */
export function DetailSkeleton() {
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
