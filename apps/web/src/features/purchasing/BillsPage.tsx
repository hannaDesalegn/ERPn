/**
 * Supplier bills: list and detail.
 *
 * The mirror of customer invoices, with one addition that matters: the
 * three-way match status. A bill that does not reconcile against the purchase
 * order and the goods receipt must not be paid, so the match state is a primary
 * column here rather than a detail.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { SupplierBill } from '@/domain';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Icon, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import {
  DetailGrid,
  DetailSkeleton,
  DetailTitle,
  HistoryPanel,
  InvoiceLinesTable,
  RelatedPanel,
  TotalsBlock,
} from '@/components/domain/detail';
import { useSession } from '@/app/session';
import { useListParams } from '@/hooks/useListParams';
import { cn, daysUntil, formatDate, formatDateTime, formatNumber } from '@/lib/format';
import { formatMoney } from '@/lib/money';

export function BillsPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'invoiceDate', filterKeys: ['status', 'matchStatus'] });

  const query = useQuery({
    queryKey: queryKeys.supplierBills(list.params),
    queryFn: () => api.finance.listSupplierBills(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<SupplierBill>[] = [
    {
      key: 'docNumber',
      header: 'Bill',
      sortable: true,
      width: '150px',
      render: (b) => <span className="font-medium text-accent-text">{b.docNumber}</span>,
    },
    {
      key: 'party',
      header: 'Supplier',
      render: (b) => <span className="truncate text-primary">{b.party.name}</span>,
    },
    {
      key: 'ref',
      header: 'Their ref',
      hideBelow: 'xl',
      width: '140px',
      render: (b) => <span className="text-muted tabular">{b.supplierReference}</span>,
    },
    {
      key: 'dueDate',
      header: 'Due',
      sortable: true,
      width: '140px',
      numeric: true,
      render: (b) => {
        const days = daysUntil(b.dueDate);
        const late = days < 0 && b.balanceDue.amount > 0;
        return (
          <span className={cn(late && 'font-medium text-danger-text')}>
            {formatDate(b.dueDate)}
            {late && <span className="ml-1 text-2xs">({-days}d late)</span>}
          </span>
        );
      },
    },
    {
      /** The payment control. A variance here blocks payment. */
      key: 'matchStatus',
      header: 'Match',
      width: '140px',
      hideBelow: 'lg',
      render: (b) => <StatusBadge status={b.matchStatus} />,
    },
    {
      key: 'balanceDue',
      header: 'Outstanding',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      render: (b) => (
        <MoneyText
          value={b.balanceDue}
          strong
          className={b.balanceDue.amount > 0 ? 'text-primary' : 'text-muted'}
        />
      ),
    },
    { key: 'status', header: 'Status', sortable: true, width: '135px', render: (b) => <StatusBadge status={b.status} /> },
  ];

  const totals = query.data?.totals;

  return (
    <>
      <PageHeader title="Supplier bills" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search bill, supplier, reference"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search bills"
          />
          <Select
            value={list.filters['matchStatus']?.[0] ?? ''}
            onChange={(e) => list.setFilter('matchStatus', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by match status"
          >
            <option value="">Any match state</option>
            <option value="matched">Matched</option>
            <option value="quantity_variance">Quantity variance</option>
            <option value="price_variance">Price variance</option>
            <option value="not_matched">Not matched</option>
          </Select>
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && totals && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} bills ·{' '}
              <span className="font-medium text-secondary">
                {formatMoney({ amount: totals['outstanding'] ?? 0, currency: 'USD' })}
              </span>{' '}
              outstanding
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(b) => b.id}
          isLoading={query.isLoading}
          onRowClick={(b) => navigate(`/purchasing/bills/${b.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          rowTone={(b) => (b.matchStatus !== 'matched' && b.balanceDue.amount > 0 ? 'danger' : 'default')}
          emptyTitle="No bills match"
        />

        {query.data && (
          <Pagination
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onPageChange={list.setPage}
          />
        )}
      </Card>
    </>
  );
}

// ===========================================================================

export function BillDetailPage() {
  const { id = '' } = useParams();
  const { can } = useSession();

  const bill = useQuery({
    queryKey: queryKeys.supplierBill(id),
    queryFn: () => api.finance.getSupplierBill(id),
  });

  if (bill.isError) return <ErrorState message={(bill.error as Error).message} />;
  if (bill.isLoading || !bill.data) return <DetailSkeleton />;

  const b = bill.data;
  const days = daysUntil(b.dueDate);
  const late = days < 0 && b.balanceDue.amount > 0;
  const blocked = b.matchStatus !== 'matched';

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/purchasing/bills"
            backLabel="Back to bills"
            docNumber={b.docNumber}
            status={b.status}
          />
        }
        subtitle={`${b.party.name} · dated ${formatDate(b.invoiceDate)}`}
        meta={
          <>
            <StatusBadge status={b.matchStatus} />
            {late && <Badge tone="danger">Overdue by {-days} days</Badge>}
          </>
        }
        actions={
          b.balanceDue.amount > 0 &&
          can('payments:register') && (
            <Button
              icon="bank"
              disabled
              title={
                blocked
                  ? 'Blocked: this bill does not reconcile against the order and receipt'
                  : 'Records a payment against this bill'
              }
            >
              Pay bill
            </Button>
          )
        }
      />

      <DetailGrid
        main={
          <>
            {/*
              A failed match is stated plainly at the top of the document, not
              buried in a side panel. It is the reason someone should stop.
            */}
            {blocked && (
              <Card className="border-danger/40 bg-danger-soft/30">
                <div className="flex items-start gap-2">
                  <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-danger-text" />
                  <div>
                    <p className="text-sm font-medium text-danger-text">
                      Three-way match failed: {b.matchStatus.replace(/_/g, ' ')}
                    </p>
                    <p className="mt-0.5 text-xs text-secondary">
                      What the supplier has charged does not agree with{' '}
                      {b.purchaseOrderNumbers.join(', ')} and the recorded goods receipt. Resolve the
                      difference before releasing payment.
                    </p>
                  </div>
                </div>
              </Card>
            )}

            <Card padded={false}>
              <CardHeader title="Bill details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Supplier">
                  <Link to={`/purchasing/suppliers/${b.party.id}`} className="text-accent-text hover:underline">
                    {b.party.name}
                  </Link>
                </Field>
                <Field label="Their reference">{b.supplierReference}</Field>
                <Field label="Bill date">{formatDate(b.invoiceDate)}</Field>
                <Field label="Due date">{formatDate(b.dueDate)}</Field>
                <Field label="Purchase orders">
                  {b.purchaseOrderNumbers.map((n, i) => (
                    <Link
                      key={n}
                      to={`/purchasing/orders/${b.purchaseOrderIds[i]}`}
                      className="text-accent-text hover:underline"
                    >
                      {n}
                    </Link>
                  ))}
                </Field>
                <Field label="Posted at">{formatDateTime(b.postedAt)}</Field>
                <Field label="Posted by">{b.postedBy?.name}</Field>
                <Field label="Journal entry">
                  {b.journalEntryId && (
                    <Link
                      to={`/accounting/journal/${b.journalEntryId}`}
                      className="text-accent-text hover:underline"
                    >
                      {b.journalEntryNumber}
                    </Link>
                  )}
                </Field>
              </dl>
            </Card>

            <Card padded={false}>
              <CardHeader title="Line items" subtitle={`${b.lines.length} lines`} />
              <InvoiceLinesTable lines={b.lines} />
              <TotalsBlock
                subtotal={b.subtotal}
                taxTotal={b.taxTotal}
                total={b.total}
                paid={b.paidAmount}
                balanceDue={b.balanceDue}
              />
            </Card>
          </>
        }
        aside={
          <>
            <Card padded={false}>
              <CardHeader title="Outstanding" />
              <div className="p-4">
                <p className="text-2xl font-semibold text-primary tabular">
                  <MoneyText value={b.balanceDue} />
                </p>
                <p className="text-xs text-muted">
                  of <MoneyText value={b.total} muted /> billed
                </p>
              </div>
            </Card>

            <RelatedPanel links={b.links} />
            <HistoryPanel targetId={b.id} />

            <Card>
              <p className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted uppercase">
                <Icon name="ledger" className="size-3" />
                Accounting effect
              </p>
              <p className="mt-1.5 text-xs text-secondary">
                Posting debited <span className="font-medium text-primary">Inventory</span>{' '}
                {formatMoney(b.subtotal)} and credited{' '}
                <span className="font-medium text-primary">Accounts Payable</span>{' '}
                {formatMoney(b.total)}, recording the obligation to pay.
              </p>
            </Card>
          </>
        }
      />
    </>
  );
}
