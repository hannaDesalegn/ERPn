/**
 * Purchase orders list.
 *
 * Differs from the sales order list in one important way: it leads with
 * approval state. Spending company money needs authorisation, so "what is
 * waiting for me to approve" is the first question this screen answers.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { PurchaseOrder } from '@/domain';
import { Card, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { useListParams } from '@/hooks/useListParams';
import { formatDate, formatNumber } from '@/lib/format';
import { formatMoney } from '@/lib/money';

const STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'partially_received',
  'received',
  'billed',
  'cancelled',
] as const;

export function PurchaseOrdersPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'orderDate', filterKeys: ['status', 'warehouseId'] });

  const query = useQuery({
    queryKey: queryKeys.purchaseOrders(list.params),
    queryFn: () => api.purchasing.listOrders(list.params),
    placeholderData: keepPreviousData,
  });

  const warehouses = useQuery({ queryKey: queryKeys.warehouses, queryFn: api.inventory.listWarehouses });

  const columns: Column<PurchaseOrder>[] = [
    {
      key: 'docNumber',
      header: 'Order',
      sortable: true,
      width: '130px',
      render: (po) => <span className="font-medium text-accent-text">{po.docNumber}</span>,
    },
    {
      key: 'orderDate',
      header: 'Ordered',
      sortable: true,
      width: '105px',
      numeric: true,
      render: (po) => <span className="text-secondary">{formatDate(po.orderDate)}</span>,
    },
    {
      key: 'supplier',
      header: 'Supplier',
      sortable: true,
      render: (po) => <span className="truncate text-primary">{po.supplier.name}</span>,
    },
    {
      key: 'expected',
      header: 'Expected',
      width: '105px',
      numeric: true,
      hideBelow: 'lg',
      render: (po) => <span className="text-secondary">{formatDate(po.expectedDate)}</span>,
    },
    {
      key: 'requestedBy',
      header: 'Raised by',
      hideBelow: 'xl',
      render: (po) => <span className="text-secondary">{po.requestedBy.name}</span>,
    },
    {
      /** Received against ordered, summed across lines. */
      key: 'received',
      header: 'Received',
      align: 'right',
      numeric: true,
      width: '90px',
      hideBelow: 'md',
      render: (po) => {
        if (po.status === 'draft' || po.status === 'cancelled' || po.status === 'pending_approval') return null;
        const ordered = po.lines.reduce((a, l) => a + l.quantity, 0);
        const received = po.lines.reduce((a, l) => a + l.receivedQuantity, 0);
        const pct = ordered === 0 ? 0 : Math.round((received / ordered) * 100);
        return <span className={pct === 100 ? 'text-success-text' : 'text-secondary'}>{pct}%</span>;
      },
    },
    {
      key: 'total',
      header: 'Total',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '110px',
      render: (po) => <MoneyText value={po.total} strong />,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '150px',
      render: (po) => <StatusBadge status={po.status} />,
    },
  ];

  const totalValue = query.data?.totals?.['value'];

  return (
    <>
      <PageHeader title="Purchase orders" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search order, supplier"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search purchase orders"
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
          <Select
            value={list.filters['warehouseId']?.[0] ?? ''}
            onChange={(e) => list.setFilter('warehouseId', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by warehouse"
          >
            <option value="">All warehouses</option>
            {warehouses.data?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
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
              {formatNumber(query.data.total)} orders
              {totalValue !== undefined && (
                <>
                  {' · '}
                  <span className="font-medium text-secondary">
                    {formatMoney({ amount: totalValue, currency: 'USD' })}
                  </span>
                </>
              )}
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(po) => po.id}
          isLoading={query.isLoading}
          onRowClick={(po) => navigate(`/purchasing/orders/${po.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          rowTone={(po) => (po.status === 'cancelled' ? 'muted' : 'default')}
          emptyTitle="No purchase orders match"
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
