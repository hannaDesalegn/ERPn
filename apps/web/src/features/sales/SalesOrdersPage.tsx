/**
 * Sales orders list.
 *
 * BUSINESS PURPOSE: the sales team's working queue. The questions it answers are
 * "what have we promised", "what is waiting to ship", and "what has not been
 * invoiced yet" — which is why the status filter is the primary control and the
 * delivery/invoice progress is visible per row rather than hidden in the detail.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { SalesOrderRow } from '@/services/sales.service';
import { Button, Card, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { useListParams } from '@/hooks/useListParams';
import { useSession } from '@/app/session';
import { formatDate, formatNumber } from '@/lib/format';
import { formatMoney } from '@/lib/money';

const STATUSES = [
  'draft',
  'confirmed',
  'partially_delivered',
  'delivered',
  'invoiced',
  'cancelled',
] as const;

export function SalesOrdersPage() {
  const navigate = useNavigate();
  const { can } = useSession();
  const list = useListParams({
    defaultSortBy: 'orderDate',
    filterKeys: ['status', 'warehouseId'],
  });

  const query = useQuery({
    queryKey: queryKeys.salesOrders(list.params),
    queryFn: () => api.sales.listOrders(list.params),
    // Keeps the previous page visible while the next loads, so the table does
    // not collapse to skeletons on every keystroke.
    placeholderData: keepPreviousData,
  });

  // The real read, not the fixture one the stock and purchasing screens still share. Those
  // render fixture documents whose warehouse identifiers exist only in the mocks, so pointing
  // their filter here would list warehouses matching none of their rows.
  const warehouses = useQuery({
    queryKey: queryKeys.warehouseOptions,
    queryFn: api.masterData.listWarehouses,
  });

  const columns: Column<SalesOrderRow>[] = [
    {
      key: 'docNumber',
      header: 'Order',
      sortable: true,
      width: '130px',
      // A draft has no number until confirmation allocates one, per section 12.2.
      render: (order) => (
        <span className={order.docNumber ? 'font-medium text-accent-text' : 'text-muted'}>
          {order.docNumber ?? 'Draft'}
        </span>
      ),
    },
    {
      key: 'orderDate',
      header: 'Date',
      sortable: true,
      width: '105px',
      numeric: true,
      render: (order) => <span className="text-secondary">{formatDate(order.orderDate)}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      sortable: true,
      render: (order) => <span className="truncate text-primary">{order.customer.name}</span>,
    },
    {
      key: 'warehouse',
      header: 'Warehouse',
      hideBelow: 'lg',
      render: (order) => <span className="text-secondary">{order.warehouse.name}</span>,
    },
    {
      key: 'rep',
      header: 'Rep',
      hideBelow: 'xl',
      // Nullable in the column, so nullable here rather than a name nobody has.
      render: (order) => (
        <span className="text-secondary">{order.salesRep?.name ?? 'Not assigned'}</span>
      ),
    },
    {
      key: 'lines',
      header: 'Lines',
      align: 'right',
      numeric: true,
      hideBelow: 'md',
      width: '60px',
      render: (order) => <span className="text-muted">{order.lineCount}</span>,
    },
    {
      /**
       * FULFILMENT PROGRESS — delivered vs ordered, summed across lines.
       * Shown in the list because "is it shipped yet" is the single most common
       * question about an open order, and making users open each one to find
       * out is what makes ERPs feel slow.
       */
      key: 'progress',
      header: 'Delivered',
      align: 'right',
      numeric: true,
      hideBelow: 'md',
      width: '90px',
      render: (order) => {
        // Summed by the database across the whole order rather than from lines sent for the
        // purpose. The screen shows a percentage; it does not need the document.
        const pct =
          order.orderedQuantity === 0
            ? 0
            : Math.round((order.deliveredQuantity / order.orderedQuantity) * 100);
        // Delivery progress does not apply to a draft or a cancelled order, so
        // the cell stays empty rather than reporting a misleading 0%.
        if (order.status === 'draft' || order.status === 'cancelled') return null;
        return (
          <span className={pct === 100 ? 'text-success-text' : 'text-secondary'}>
            {pct}%
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
      render: (order) => <MoneyText value={order.total} strong />,
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      width: '140px',
      render: (order) => <StatusBadge status={order.status} />,
    },
  ];

  const totalValue = query.data?.totals?.['value'];

  return (
    <>
      <PageHeader
        title="Sales orders"
        actions={
          can('sales:create') ? (
            <Button variant="primary" icon="plus" disabled title="Creation forms are a later milestone">
              New order
            </Button>
          ) : undefined
        }
      />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search order, customer, rep…"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search sales orders"
          />

          <Select
            value={list.filters['status']?.[0] ?? ''}
            onChange={(e) => list.setFilter('status', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>

          <Select
            value={list.filters['warehouseId']?.[0] ?? ''}
            onChange={(e) => list.setFilter('warehouseId', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by warehouse"
          >
            <option value="">All warehouses</option>
            {warehouses.data?.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </Select>

          {list.isFiltered && (
            <Button size="sm" variant="ghost" icon="close" onClick={list.clearAll}>
              Clear
            </Button>
          )}

          {/* The count appears once it is known. A placeholder in its place
              would only be filler while the request is in flight. */}
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
          rowKey={(order) => order.id}
          isLoading={query.isLoading}
          onRowClick={(order) => navigate(`/sales/orders/${order.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          rowTone={(order) => (order.status === 'cancelled' ? 'muted' : 'default')}
          emptyTitle="No sales orders match"
          emptyDescription="Try clearing the filters or searching for a different customer."
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
