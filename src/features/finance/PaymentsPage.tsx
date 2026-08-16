/**
 * Payments: list and detail.
 *
 * A payment is not attached to one invoice. A customer wires a round number
 * covering three invoices, or part-pays one. So the money and its ALLOCATIONS
 * are separate facts, and cash that has arrived but not been matched to an
 * invoice is visible rather than hidden. Unallocated cash is a real state that
 * finance teams have to work through, not an error.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { Payment } from '@/domain';
import { Badge, Card, CardHeader, ErrorState, Field, Icon, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import {
  AllocationsPanel,
  DetailGrid,
  DetailSkeleton,
  DetailTitle,
  HistoryPanel,
  RelatedPanel,
} from '@/components/domain/detail';
import { useListParams } from '@/hooks/useListParams';
import { cn, formatDate, formatNumber, humanize } from '@/lib/format';

export function PaymentsPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'paymentDate', filterKeys: ['direction', 'method'] });

  const query = useQuery({
    queryKey: queryKeys.payments(list.params),
    queryFn: () => api.finance.listPayments(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<Payment>[] = [
    {
      key: 'docNumber',
      header: 'Payment',
      sortable: true,
      width: '140px',
      render: (p) => <span className="font-medium text-accent-text">{p.docNumber}</span>,
    },
    {
      /** Direction is the first thing to read: is this money in or money out. */
      key: 'direction',
      header: '',
      width: '44px',
      render: (p) => (
        <span
          className={cn(
            'grid size-5 place-items-center rounded-full',
            p.direction === 'inbound' ? 'bg-success-soft text-success-text' : 'bg-warning-soft text-warning-text',
          )}
          title={p.direction === 'inbound' ? 'Received' : 'Paid out'}
        >
          <Icon name={p.direction === 'inbound' ? 'arrowDown' : 'arrowUp'} className="size-3" />
        </span>
      ),
    },
    {
      key: 'party',
      header: 'Party',
      render: (p) => <span className="truncate text-primary">{p.party.name}</span>,
    },
    {
      key: 'paymentDate',
      header: 'Date',
      sortable: true,
      width: '110px',
      numeric: true,
      render: (p) => <span className="text-secondary">{formatDate(p.paymentDate)}</span>,
    },
    {
      key: 'method',
      header: 'Method',
      width: '130px',
      hideBelow: 'md',
      render: (p) => <span className="text-secondary">{humanize(p.method)}</span>,
    },
    {
      key: 'account',
      header: 'Account',
      hideBelow: 'xl',
      render: (p) => <span className="text-secondary">{p.cashAccountName}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      render: (p) => (
        <MoneyText
          value={p.amount}
          strong
          className={p.direction === 'inbound' ? 'text-success-text' : 'text-primary'}
        />
      ),
    },
    {
      key: 'unallocated',
      header: '',
      width: '110px',
      render: (p) => (p.unallocatedAmount.amount > 0 ? <Badge tone="warning">Unallocated</Badge> : null),
    },
  ];

  return (
    <>
      <PageHeader title="Payments" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search payment, party, reference"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search payments"
          />
          <Select
            value={list.filters['direction']?.[0] ?? ''}
            onChange={(e) => list.setFilter('direction', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by direction"
          >
            <option value="">Money in and out</option>
            <option value="inbound">Received from customers</option>
            <option value="outbound">Paid to suppliers</option>
          </Select>
          <Select
            value={list.filters['method']?.[0] ?? ''}
            onChange={(e) => list.setFilter('method', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by method"
          >
            <option value="">All methods</option>
            {['bank_transfer', 'cash', 'cheque', 'card', 'mobile_money'].map((m) => (
              <option key={m} value={m}>
                {humanize(m)}
              </option>
            ))}
          </Select>
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} payments
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(p) => p.id}
          isLoading={query.isLoading}
          onRowClick={(p) => navigate(`/finance/payments/${p.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No payments match"
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

export function PaymentDetailPage() {
  const { id = '' } = useParams();
  const payment = useQuery({ queryKey: queryKeys.payment(id), queryFn: () => api.finance.getPayment(id) });

  if (payment.isError) return <ErrorState message={(payment.error as Error).message} />;
  if (payment.isLoading || !payment.data) return <DetailSkeleton />;

  const p = payment.data;
  const inbound = p.direction === 'inbound';
  const partyRoute = inbound ? `/sales/customers/${p.party.id}` : `/purchasing/suppliers/${p.party.id}`;

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/finance/payments"
            backLabel="Back to payments"
            docNumber={p.docNumber}
            status={p.status}
          />
        }
        subtitle={`${inbound ? 'Received from' : 'Paid to'} ${p.party.name} on ${formatDate(p.paymentDate)}`}
        meta={p.unallocatedAmount.amount > 0 ? <Badge tone="warning">Partly unallocated</Badge> : undefined}
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Payment details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label={inbound ? 'Customer' : 'Supplier'}>
                  <Link to={partyRoute} className="text-accent-text hover:underline">
                    {p.party.name}
                  </Link>
                </Field>
                <Field label="Date">{formatDate(p.paymentDate)}</Field>
                <Field label="Method">{humanize(p.method)}</Field>
                <Field label="Direction">{inbound ? 'Money in' : 'Money out'}</Field>
                <Field label="Cash account">{p.cashAccountName}</Field>
                <Field label="Reference">{p.reference}</Field>
                <Field label="Journal entry">
                  {p.journalEntryId && (
                    <Link
                      to={`/accounting/journal/${p.journalEntryId}`}
                      className="text-accent-text hover:underline"
                    >
                      {p.journalEntryNumber}
                    </Link>
                  )}
                </Field>
                <Field label="Status">
                  <StatusBadge status={p.status} />
                </Field>
              </dl>
              {p.notes && (
                <p className="border-t border-line px-4 py-3 text-sm text-secondary">{p.notes}</p>
              )}
            </Card>

            <AllocationsPanel allocations={p.allocations} unallocated={p.unallocatedAmount} />
          </>
        }
        aside={
          <>
            <Card padded={false}>
              <CardHeader title="Amount" />
              <div className="p-4">
                <p
                  className={cn(
                    'text-2xl font-semibold tabular',
                    inbound ? 'text-success-text' : 'text-primary',
                  )}
                >
                  <MoneyText value={p.amount} />
                </p>
                <p className="text-xs text-muted">
                  {inbound ? 'Received into' : 'Paid from'} {p.cashAccountName}
                </p>
              </div>
            </Card>

            <RelatedPanel links={p.links} />
            <HistoryPanel targetId={p.id} />

            <Card>
              <p className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted uppercase">
                <Icon name="ledger" className="size-3" />
                Accounting effect
              </p>
              <p className="mt-1.5 text-xs text-secondary">
                {inbound ? (
                  <>
                    Debited <span className="font-medium text-primary">{p.cashAccountName}</span> and
                    credited <span className="font-medium text-primary">Accounts Receivable</span>. The
                    customer owes us less; we hold more cash.
                  </>
                ) : (
                  <>
                    Debited <span className="font-medium text-primary">Accounts Payable</span> and
                    credited <span className="font-medium text-primary">{p.cashAccountName}</span>. We owe
                    the supplier less; we hold less cash.
                  </>
                )}
              </p>
            </Card>
          </>
        }
      />
    </>
  );
}
