/**
 * Customers list.
 *
 * The commercial question this screen answers is not "who are our customers"
 * but "who owes us money and can they take more credit". So the balance and the
 * credit utilisation are primary columns, not details hidden one click away.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { Customer } from '@/domain';
import { Badge, Card, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { useListParams } from '@/hooks/useListParams';
import { cn, formatNumber } from '@/lib/format';

export function CustomersPage() {
  const navigate = useNavigate();
  const list = useListParams({
    defaultSortBy: 'name',
    defaultSortDir: 'asc',
    filterKeys: ['active', 'paymentTerms'],
  });

  const query = useQuery({
    queryKey: queryKeys.customers(list.params),
    queryFn: () => api.parties.listCustomers(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<Customer>[] = [
    {
      key: 'code',
      header: 'Code',
      sortable: true,
      width: '110px',
      render: (c) => <span className="text-secondary tabular">{c.code}</span>,
    },
    {
      key: 'name',
      header: 'Customer',
      sortable: true,
      render: (c) => (
        <>
          <span className="block truncate font-medium text-primary">{c.name}</span>
          <span className="text-xs text-muted">
            {c.address?.city}, {c.address?.country}
          </span>
        </>
      ),
    },
    {
      key: 'terms',
      header: 'Terms',
      width: '110px',
      hideBelow: 'md',
      render: (c) => <span className="text-secondary">{c.paymentTerms.label}</span>,
    },
    {
      key: 'balance',
      header: 'Owes us',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      render: (c) => <MoneyText value={c.balance} strong />,
    },
    {
      key: 'creditLimit',
      header: 'Credit limit',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      hideBelow: 'lg',
      render: (c) => <MoneyText value={c.creditLimit} muted />,
    },
    {
      /**
       * Credit utilisation as a bar. A salesperson needs to know at a glance
       * whether the next order will push this customer past their limit, which
       * a raw pair of numbers does not communicate quickly.
       */
      key: 'utilisation',
      header: 'Credit used',
      width: '130px',
      hideBelow: 'lg',
      render: (c) => {
        const pct = (c.balance.amount / Math.max(1, c.creditLimit.amount)) * 100;
        return (
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
              <div
                className={cn(
                  'h-full rounded-full',
                  pct > 100 ? 'bg-danger' : pct > 80 ? 'bg-warning' : 'bg-success',
                )}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </div>
            <span className="w-8 text-right text-xs text-muted tabular">{pct.toFixed(0)}%</span>
          </div>
        );
      },
    },
    {
      key: 'status',
      header: '',
      width: '90px',
      render: (c) =>
        !c.active ? (
          <Badge tone="neutral">Archived</Badge>
        ) : c.balance.amount > c.creditLimit.amount ? (
          <Badge tone="danger">Over limit</Badge>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="Customers" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search name, code, city"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search customers"
          />
          <Select
            value={list.filters['active']?.[0] ?? ''}
            onChange={(e) => list.setFilter('active', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by status"
          >
            <option value="">All customers</option>
            <option value="true">Active only</option>
            <option value="false">Archived only</option>
          </Select>
          {list.isFiltered && (
            <button
              type="button"
              onClick={list.clearAll}
              className="text-xs text-accent-text hover:underline"
            >
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} customers
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(c) => c.id}
          isLoading={query.isLoading}
          onRowClick={(c) => navigate(`/sales/customers/${c.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          rowTone={(c) => (c.active ? 'default' : 'muted')}
          emptyTitle="No customers match"
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
