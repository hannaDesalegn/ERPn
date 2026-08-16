/**
 * Customer invoices: list and detail.
 *
 * An invoice is a legal claim for money. Posting it is the moment it becomes
 * one, which is why the screen distinguishes total from outstanding everywhere:
 * the total is what was billed, the outstanding balance is what still matters.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { CustomerInvoice } from '@/domain';
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

const STATUSES = ['draft', 'posted', 'partially_paid', 'paid', 'overdue', 'cancelled'] as const;

export function InvoicesPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'invoiceDate', filterKeys: ['status'] });

  const query = useQuery({
    queryKey: queryKeys.customerInvoices(list.params),
    queryFn: () => api.finance.listCustomerInvoices(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<CustomerInvoice>[] = [
    {
      key: 'docNumber',
      header: 'Invoice',
      sortable: true,
      width: '145px',
      render: (i) => <span className="font-medium text-accent-text">{i.docNumber}</span>,
    },
    {
      key: 'party',
      header: 'Customer',
      sortable: true,
      render: (i) => <span className="truncate text-primary">{i.party.name}</span>,
    },
    {
      key: 'invoiceDate',
      header: 'Issued',
      sortable: true,
      width: '105px',
      numeric: true,
      render: (i) => <span className="text-secondary">{formatDate(i.invoiceDate)}</span>,
    },
    {
      /**
       * Due date carries the lateness inline. A date alone forces the reader to
       * do the subtraction, and the whole point of the column is the answer.
       */
      key: 'dueDate',
      header: 'Due',
      sortable: true,
      width: '140px',
      numeric: true,
      render: (i) => {
        const days = daysUntil(i.dueDate);
        const late = days < 0 && i.balanceDue.amount > 0;
        return (
          <span className={cn(late && 'font-medium text-danger-text')}>
            {formatDate(i.dueDate)}
            {late && <span className="ml-1 text-2xs">({-days}d late)</span>}
          </span>
        );
      },
    },
    {
      key: 'total',
      header: 'Total',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '110px',
      hideBelow: 'md',
      render: (i) => <MoneyText value={i.total} />,
    },
    {
      key: 'balanceDue',
      header: 'Outstanding',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      render: (i) => (
        <MoneyText
          value={i.balanceDue}
          strong
          className={i.balanceDue.amount > 0 ? 'text-danger-text' : 'text-muted'}
        />
      ),
    },
    { key: 'status', header: 'Status', sortable: true, width: '135px', render: (i) => <StatusBadge status={i.status} /> },
  ];

  const totals = query.data?.totals;

  return (
    <>
      <PageHeader title="Customer invoices" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search invoice, customer, order"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search invoices"
          />
          <Select
            value={list.filters['status']?.[0] ?? ''}
            onChange={(e) => list.setFilter('status', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && totals && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} invoices ·{' '}
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
          rowKey={(i) => i.id}
          isLoading={query.isLoading}
          onRowClick={(i) => navigate(`/sales/invoices/${i.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          rowTone={(i) => (i.status === 'overdue' ? 'danger' : i.status === 'cancelled' ? 'muted' : 'default')}
          emptyTitle="No invoices match"
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

export function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const { can } = useSession();

  const invoice = useQuery({
    queryKey: queryKeys.customerInvoice(id),
    queryFn: () => api.finance.getCustomerInvoice(id),
  });

  if (invoice.isError) return <ErrorState message={(invoice.error as Error).message} />;
  if (invoice.isLoading || !invoice.data) return <DetailSkeleton />;

  const inv = invoice.data;
  const days = daysUntil(inv.dueDate);
  const late = days < 0 && inv.balanceDue.amount > 0;
  const isDraft = inv.status === 'draft';

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/sales/invoices"
            backLabel="Back to invoices"
            docNumber={inv.docNumber}
            status={inv.status}
          />
        }
        subtitle={`${inv.party.name} · issued ${formatDate(inv.invoiceDate)}`}
        meta={
          late ? (
            <Badge tone="danger">Overdue by {-days} days</Badge>
          ) : inv.balanceDue.amount > 0 ? (
            <Badge tone="info">Due in {days} days</Badge>
          ) : (
            <Badge tone="success">Settled</Badge>
          )
        }
        actions={
          <>
            {isDraft && can('invoices:post') && (
              <Button variant="primary" icon="ledger" disabled title="Posting creates the receivable and the journal entry">
                Post invoice
              </Button>
            )}
            {!isDraft && inv.balanceDue.amount > 0 && can('payments:register') && (
              <Button icon="bank" disabled title="Records a receipt against this invoice">
                Register payment
              </Button>
            )}
          </>
        }
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Invoice details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Customer">
                  <Link to={`/sales/customers/${inv.party.id}`} className="text-accent-text hover:underline">
                    {inv.party.name}
                  </Link>
                </Field>
                <Field label="Invoice date">{formatDate(inv.invoiceDate)}</Field>
                <Field label="Due date">{formatDate(inv.dueDate)}</Field>
                <Field label="Currency">{inv.currency}</Field>
                <Field label="Sales orders">
                  {inv.salesOrderNumbers.map((n, i) => (
                    <Link
                      key={n}
                      to={`/sales/orders/${inv.salesOrderIds[i]}`}
                      className="text-accent-text hover:underline"
                    >
                      {n}
                    </Link>
                  ))}
                </Field>
                <Field label="Posted at">{formatDateTime(inv.postedAt)}</Field>
                <Field label="Posted by">{inv.postedBy?.name}</Field>
                <Field label="Journal entry">
                  {inv.journalEntryId && (
                    <Link
                      to={`/accounting/journal/${inv.journalEntryId}`}
                      className="text-accent-text hover:underline"
                    >
                      {inv.journalEntryNumber}
                    </Link>
                  )}
                </Field>
              </dl>
            </Card>

            <Card padded={false}>
              <CardHeader title="Line items" subtitle={`${inv.lines.length} lines`} />
              <InvoiceLinesTable lines={inv.lines} />
              <TotalsBlock
                subtotal={inv.subtotal}
                taxTotal={inv.taxTotal}
                total={inv.total}
                paid={inv.paidAmount}
                balanceDue={inv.balanceDue}
              />
            </Card>
          </>
        }
        aside={
          <>
            <Card padded={false}>
              <CardHeader title="Outstanding" />
              <div className="p-4">
                <p
                  className={cn(
                    'text-2xl font-semibold tabular',
                    inv.balanceDue.amount > 0 ? 'text-danger-text' : 'text-primary',
                  )}
                >
                  <MoneyText value={inv.balanceDue} />
                </p>
                <p className="text-xs text-muted">
                  of <MoneyText value={inv.total} muted /> billed
                </p>
              </div>
            </Card>

            <RelatedPanel links={inv.links} />
            <HistoryPanel targetId={inv.id} />

            {!isDraft && (
              <Card>
                <p className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted uppercase">
                  <Icon name="ledger" className="size-3" />
                  Accounting effect
                </p>
                <p className="mt-1.5 text-xs text-secondary">
                  Posting debited <span className="font-medium text-primary">Accounts Receivable</span>{' '}
                  {formatMoney(inv.total)}, credited{' '}
                  <span className="font-medium text-primary">Product Sales</span>{' '}
                  {formatMoney(inv.subtotal)} and{' '}
                  <span className="font-medium text-primary">VAT Payable</span>{' '}
                  {formatMoney(inv.taxTotal)}.
                </p>
              </Card>
            )}
          </>
        }
      />
    </>
  );
}
