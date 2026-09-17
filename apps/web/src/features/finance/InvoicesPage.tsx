/**
 * Customer invoices: the list, still over fixtures.
 *
 * The detail screen reads the server and lives in `CustomerInvoiceDetailPage.tsx`. This list has no
 * endpoint behind it, so it stays sample data and its rows do not open that screen.
 *
 * An invoice is a legal claim for money. Posting it is the moment it becomes
 * one, which is why the screen distinguishes total from outstanding everywhere:
 * the total is what was billed, the outstanding balance is what still matters.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, queryKeys, agingReference } from '@/services';
import type { CustomerInvoice } from '@/domain';
import { Card, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { useListParams } from '@/hooks/useListParams';
import { cn, daysUntil, formatDate, formatNumber } from '@/lib/format';
import { formatMoney } from '@/lib/money';

const STATUSES = ['draft', 'posted', 'partially_paid', 'paid', 'overdue', 'cancelled'] as const;

export function InvoicesPage() {
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
        const days = daysUntil(i.dueDate, agingReference());
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
          /*
            NO ROW NAVIGATION. These rows are sample data, and the invoice detail route now reads
            the server, where a fixture identifier names nothing. A row that opened "not found"
            every time would be a control that does nothing useful.
          */
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
