/**
 * Cross-document components. These are what make the app feel like one system.
 *
 * `RelatedDocuments` is the single highest-value component in this codebase.
 * Standing on a sales order you can see the delivery it produced, the invoice
 * raised from it, the payment that settled the invoice, and the journal entry
 * the posting created. That chain IS the ERP. Without it you have a set of
 * separate CRUD screens that happen to share a sidebar.
 */

import { Link } from 'react-router-dom';
import type { AuditEvent, DocType, DocumentRef } from '@/domain';
import { Icon, type IconName } from '@/components/ui';
import { MoneyText } from './MoneyText';
import { StatusBadge } from './StatusBadge';
import { cn, formatDate, formatRelative, humanize, initials } from '@/lib/format';
import { resolveDocumentRefs } from '@/services';

// ---------------------------------------------------------------------------
// Routing map — one place that knows where each document type lives
// ---------------------------------------------------------------------------

const DOC_ROUTES: Record<DocType, (id: string) => string> = {
  sales_order: (id) => `/sales/orders/${id}`,
  delivery: (id) => `/sales/deliveries/${id}`,
  customer_invoice: (id) => `/sales/invoices/${id}`,
  customer_payment: (id) => `/finance/payments/${id}`,
  purchase_order: (id) => `/purchasing/orders/${id}`,
  goods_receipt: (id) => `/purchasing/receipts/${id}`,
  supplier_bill: (id) => `/purchasing/bills/${id}`,
  supplier_payment: (id) => `/finance/payments/${id}`,
  stock_transfer: (id) => `/inventory/transfers/${id}`,
  inventory_adjustment: (id) => `/inventory/adjustments/${id}`,
  journal_entry: (id) => `/accounting/journal/${id}`,
};

const DOC_LABELS: Record<DocType, string> = {
  sales_order: 'Sales order',
  delivery: 'Delivery',
  customer_invoice: 'Customer invoice',
  customer_payment: 'Customer payment',
  purchase_order: 'Purchase order',
  goods_receipt: 'Goods receipt',
  supplier_bill: 'Supplier bill',
  supplier_payment: 'Supplier payment',
  stock_transfer: 'Stock transfer',
  inventory_adjustment: 'Inventory adjustment',
  journal_entry: 'Journal entry',
};

const DOC_ICONS: Record<DocType, IconName> = {
  sales_order: 'sales',
  delivery: 'truck',
  customer_invoice: 'invoice',
  customer_payment: 'bank',
  purchase_order: 'cart',
  goods_receipt: 'box',
  supplier_bill: 'invoice',
  supplier_payment: 'bank',
  stock_transfer: 'truck',
  inventory_adjustment: 'box',
  journal_entry: 'ledger',
};

export const documentRoute = (ref: DocumentRef) => DOC_ROUTES[ref.docType](ref.id);
export const documentLabel = (docType: DocType) => DOC_LABELS[docType];

/** A monospace-ish, clickable document number. */
export function DocumentLink({
  refDoc,
  className,
  showIcon = false,
}: {
  refDoc: DocumentRef;
  className?: string;
  showIcon?: boolean;
}) {
  return (
    <Link
      to={documentRoute(refDoc)}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'inline-flex items-center gap-1 font-medium text-accent-text hover:underline',
        className,
      )}
    >
      {showIcon && <Icon name={DOC_ICONS[refDoc.docType]} className="size-3.5 shrink-0" />}
      {refDoc.docNumber}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Related documents
// ---------------------------------------------------------------------------

export function RelatedDocuments({ links }: { links: DocumentRef[] }) {
  const resolved = resolveDocumentRefs(links);

  if (resolved.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-xs text-muted">
        No linked documents yet. Confirming and posting this document will create them.
      </p>
    );
  }

  // Present in business-process order, not insertion order, so the chain reads
  // the way the work actually happens.
  const ORDER: DocType[] = [
    'purchase_order',
    'goods_receipt',
    'supplier_bill',
    'supplier_payment',
    'sales_order',
    'delivery',
    'customer_invoice',
    'customer_payment',
    'inventory_adjustment',
    'stock_transfer',
    'journal_entry',
  ];
  const sorted = [...resolved].sort(
    (a, b) => ORDER.indexOf(a.ref.docType) - ORDER.indexOf(b.ref.docType),
  );

  return (
    <ul className="divide-y divide-[var(--border)]">
      {sorted.map((item) => (
        <li key={`${item.ref.docType}-${item.ref.id}`}>
          <Link
            to={documentRoute(item.ref)}
            className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
          >
            <span className="rounded bg-sunken p-1.5 text-secondary">
              <Icon name={DOC_ICONS[item.ref.docType]} className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-2xs text-muted">{DOC_LABELS[item.ref.docType]}</span>
              <span className="block truncate text-sm font-medium text-primary">
                {item.ref.docNumber}
              </span>
            </span>
            {item.amount && <MoneyText value={item.amount} className="text-sm" />}
            {item.status && <StatusBadge status={item.status} />}
            <span className="hidden w-20 text-right text-xs text-muted tabular sm:block">
              {formatDate(item.date)}
            </span>
            <Icon name="chevronRight" className="size-3.5 shrink-0 text-muted" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * The document lifecycle bar.
 *
 * Shows where a document sits in its process and what happens next. This is
 * genuinely useful, not decorative: a new employee can see that an order must be
 * delivered before it can be invoiced, without being told.
 */
export function DocumentLifecycle({
  steps,
  current,
  cancelled = false,
}: {
  steps: { key: string; label: string }[];
  current: string;
  cancelled?: boolean;
}) {
  const currentIndex = steps.findIndex((s) => s.key === current);

  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Document progress">
      {steps.map((step, i) => {
        const done = !cancelled && i < currentIndex;
        const active = !cancelled && i === currentIndex;
        return (
          <li key={step.key} className="flex items-center gap-1">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap',
                active && 'bg-accent-soft text-accent-text',
                done && 'text-success-text',
                !done && !active && 'text-muted',
                cancelled && 'text-muted line-through',
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? (
                <Icon name="check" className="size-3" strokeWidth={2.5} />
              ) : (
                <span
                  className={cn(
                    'size-1.5 rounded-full',
                    active ? 'bg-accent' : 'bg-[var(--border-strong)]',
                  )}
                />
              )}
              {step.label}
            </span>
            {i < steps.length - 1 && <Icon name="chevronRight" className="size-3 text-muted/50" />}
          </li>
        );
      })}
      {cancelled && (
        <li className="ml-1">
          <span className="rounded-md bg-danger-soft px-2 py-1 text-xs font-medium text-danger-text">
            Cancelled
          </span>
        </li>
      )}
    </ol>
  );
}

export const SALES_ORDER_STEPS = [
  { key: 'draft', label: 'Draft' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'invoiced', label: 'Invoiced' },
  { key: 'paid', label: 'Paid' },
];

export const PURCHASE_ORDER_STEPS = [
  { key: 'draft', label: 'Draft' },
  { key: 'pending_approval', label: 'Approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'received', label: 'Received' },
  { key: 'billed', label: 'Billed' },
];

/** Map a real status onto the simplified lifecycle track. */
export function lifecycleStep(status: string): string {
  const MAP: Record<string, string> = {
    partially_delivered: 'confirmed',
    partially_received: 'approved',
    partially_paid: 'invoiced',
    posted: 'invoiced',
    overdue: 'invoiced',
    paid: 'paid',
  };
  return MAP[status] ?? status;
}

// ---------------------------------------------------------------------------
// Activity / audit
// ---------------------------------------------------------------------------

const ACTION_ICONS: Record<string, IconName> = {
  created: 'plus',
  updated: 'settings',
  confirmed: 'check',
  approved: 'check',
  posted: 'ledger',
  paid: 'bank',
  shipped: 'truck',
  received: 'box',
  cancelled: 'close',
  reversed: 'history',
  logged_in: 'users',
  permission_changed: 'shield',
  deleted: 'close',
  rejected: 'close',
};

export function ActivityTimeline({
  events,
  compact = false,
}: {
  events: AuditEvent[];
  compact?: boolean;
}) {
  if (events.length === 0) {
    return <p className="px-4 py-6 text-center text-xs text-muted">No recorded activity.</p>;
  }

  return (
    <ol className="relative">
      {events.map((event, i) => (
        <li key={event.id} className="relative flex gap-3 px-4 py-2.5">
          {/* Connector line between markers */}
          {i < events.length - 1 && (
            <span
              className="absolute top-9 bottom-0 left-[26px] w-px bg-[var(--border)]"
              aria-hidden="true"
            />
          )}

          <span className="z-10 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-secondary">
            <Icon name={ACTION_ICONS[event.action] ?? 'clock'} className="size-3" />
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-sm text-primary">{event.summary}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <span
                className="inline-flex size-4 items-center justify-center rounded-full bg-accent-soft text-[8px] font-semibold text-accent-text"
                aria-hidden="true"
              >
                {initials(event.actor.name)}
              </span>
              <span className="text-secondary">{event.actor.name}</span>
              <span>·</span>
              <span>{humanize(event.actorRole)}</span>
              <span>·</span>
              <time dateTime={event.occurredAt} title={event.occurredAt}>
                {formatRelative(event.occurredAt)}
              </time>
            </p>

            {/* Field-level before/after — the part that makes it an audit trail
                rather than a notification feed. */}
            {!compact && event.changes && event.changes.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 rounded border border-line bg-sunken px-2 py-1.5">
                {event.changes.map((change) => (
                  <li key={change.field} className="flex flex-wrap items-baseline gap-1.5 text-xs">
                    <span className="text-muted">{change.label}:</span>
                    <span className="text-secondary line-through">{change.before ?? 'Not set'}</span>
                    <Icon name="arrowRight" className="size-3 text-muted" />
                    <span className="font-medium text-primary">{change.after ?? 'Not set'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
