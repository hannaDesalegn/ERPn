/**
 * Inventory screens.
 *
 * TEACHING POINT MADE VISIBLE
 * ---------------------------
 * These two screens exist as a pair on purpose:
 *
 *   "Stock on hand"    the CURRENT POSITION — a derived projection
 *   "Stock movements"  the LEDGER it is derived FROM — the source of truth
 *
 * Every number on the first screen is the sum of rows on the second. Nobody can
 * edit a quantity; they record a movement, and the position follows. Presenting
 * both, and linking each movement to the document that caused it, is what makes
 * inventory auditable instead of merely stored.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { StockLevel, StockMove } from '@/domain';
import { Badge, Card, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { DocumentLink } from '@/components/domain/documents';
import { useListParams } from '@/hooks/useListParams';
import { cn, formatDateTime, formatNumber, humanize } from '@/lib/format';

// ===========================================================================
// Stock on hand
// ===========================================================================

export function StockOnHandPage() {
  const navigate = useNavigate();
  const list = useListParams({
    defaultSortBy: 'product',
    defaultSortDir: 'asc',
    filterKeys: ['warehouseId', 'state'],
  });

  const query = useQuery({
    queryKey: queryKeys.stockLevels(list.params),
    queryFn: () => api.inventory.listStockLevels(list.params),
    placeholderData: keepPreviousData,
  });

  const warehouses = useQuery({ queryKey: queryKeys.warehouses, queryFn: api.inventory.listWarehouses });

  const columns: Column<StockLevel>[] = [
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      render: (level) => (
        <>
          <span className="block truncate font-medium text-primary">{level.productName}</span>
          <span className="text-xs text-muted">{level.productSku}</span>
        </>
      ),
    },
    {
      key: 'warehouse',
      header: 'Warehouse',
      hideBelow: 'sm',
      width: '180px',
      render: (level) => <span className="text-secondary">{level.warehouseName}</span>,
    },
    {
      key: 'onHand',
      header: 'On hand',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '90px',
      render: (level) => <span className="text-secondary">{formatNumber(level.onHand)}</span>,
    },
    {
      /** Physically present but promised to a confirmed order. */
      key: 'reserved',
      header: 'Reserved',
      align: 'right',
      numeric: true,
      width: '90px',
      hideBelow: 'md',
      // Zero reserved is a fact worth stating, so it prints as 0 rather than a
      // placeholder. Only the non-zero case is coloured, because that is the
      // one that affects what a salesperson can promise.
      render: (level) =>
        level.reserved > 0 ? (
          <span className="text-warning-text">{formatNumber(level.reserved)}</span>
        ) : (
          <span className="text-muted">0</span>
        ),
    },
    {
      /**
       * AVAILABLE is the number that matters commercially: on hand minus what is
       * already promised. Emphasised over "on hand" for exactly that reason.
       */
      key: 'available',
      header: 'Available',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '95px',
      render: (level) => (
        <span
          className={cn(
            'font-semibold',
            level.available <= 0
              ? 'text-danger-text'
              : level.available <= level.reorderPoint
                ? 'text-warning-text'
                : 'text-primary',
          )}
        >
          {formatNumber(level.available)}
        </span>
      ),
    },
    {
      key: 'incoming',
      header: 'Incoming',
      align: 'right',
      numeric: true,
      width: '90px',
      hideBelow: 'lg',
      render: (level) =>
        level.incoming > 0 ? (
          <span className="text-info-text">+{formatNumber(level.incoming)}</span>
        ) : (
          <span className="text-muted">0</span>
        ),
    },
    {
      key: 'reorderPoint',
      header: 'Reorder at',
      align: 'right',
      numeric: true,
      width: '90px',
      hideBelow: 'xl',
      render: (level) => <span className="text-muted">{formatNumber(level.reorderPoint)}</span>,
    },
    {
      key: 'valuation',
      header: 'Value',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '110px',
      render: (level) => <MoneyText value={level.valuation} />,
    },
    {
      key: 'state',
      header: '',
      width: '90px',
      render: (level) =>
        level.available <= 0 ? (
          <Badge tone="danger">Out</Badge>
        ) : level.available <= level.reorderPoint ? (
          <Badge tone="warning">Low</Badge>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Stock on hand"
        subtitle="Derived from stock movements"
      />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search product or SKU…"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search stock"
          />
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
          <Select
            value={list.filters['state']?.[0] ?? ''}
            onChange={(e) => list.setFilter('state', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by stock state"
          >
            <option value="">Any level</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
            <option value="ok">Healthy</option>
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
            <span className="ml-auto text-xs text-muted tabular">{formatNumber(query.data.total)} rows</span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(level) => `${level.productId}-${level.warehouseId}`}
          isLoading={query.isLoading}
          onRowClick={(level) => navigate(`/inventory/movements?productId=${level.productId}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No stock rows match"
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
// Stock movements
// ===========================================================================

const REASON_TONES: Record<string, 'success' | 'danger' | 'info' | 'warning' | 'neutral'> = {
  purchase_receipt: 'success',
  transfer_in: 'info',
  customer_return: 'info',
  sales_delivery: 'danger',
  transfer_out: 'info',
  supplier_return: 'warning',
  scrap: 'danger',
  adjustment: 'neutral',
};

export function StockMovementsPage() {
  const list = useListParams({
    defaultSortBy: 'occurredAt',
    filterKeys: ['reason', 'warehouseId', 'direction', 'productId'],
  });

  const query = useQuery({
    queryKey: queryKeys.stockMoves(list.params),
    queryFn: () => api.inventory.listMovements(list.params),
    placeholderData: keepPreviousData,
  });

  const warehouses = useQuery({ queryKey: queryKeys.warehouses, queryFn: api.inventory.listWarehouses });

  const columns: Column<StockMove>[] = [
    {
      key: 'occurredAt',
      header: 'When',
      sortable: true,
      width: '150px',
      numeric: true,
      render: (move) => <span className="text-secondary">{formatDateTime(move.occurredAt)}</span>,
    },
    {
      key: 'product',
      header: 'Product',
      sortable: true,
      render: (move) => (
        <>
          <span className="block truncate text-primary">{move.productName}</span>
          <span className="text-xs text-muted">{move.productSku}</span>
        </>
      ),
    },
    {
      key: 'warehouse',
      header: 'Warehouse',
      hideBelow: 'lg',
      width: '170px',
      render: (move) => <span className="text-secondary">{move.warehouseName}</span>,
    },
    {
      /** Signed quantity, coloured and prefixed so direction reads instantly. */
      key: 'quantity',
      header: 'Qty',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '85px',
      render: (move) => (
        <span className={cn('font-semibold', move.quantity >= 0 ? 'text-success-text' : 'text-danger-text')}>
          {move.quantity >= 0 ? '+' : ''}
          {formatNumber(move.quantity)}
        </span>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      width: '150px',
      render: (move) => <Badge tone={REASON_TONES[move.reason] ?? 'neutral'}>{humanize(move.reason)}</Badge>,
    },
    {
      /**
       * THE MOST IMPORTANT COLUMN.
       * Every movement points at the document that caused it. A movement with no
       * source is an unexplained stock change, which in a real system is either
       * a bug or a theft.
       */
      key: 'source',
      header: 'Source document',
      width: '160px',
      render: (move) => <DocumentLink refDoc={move.sourceDocument} showIcon />,
    },
    {
      key: 'cost',
      header: 'Unit cost',
      align: 'right',
      numeric: true,
      width: '100px',
      hideBelow: 'xl',
      render: (move) => <MoneyText value={move.unitCost} muted />,
    },
    {
      key: 'by',
      header: 'By',
      hideBelow: 'xl',
      width: '130px',
      render: (move) => <span className="text-secondary">{move.createdBy.name}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Stock movements"
        subtitle="Source ledger for all stock quantities"
      />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search product or document…"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search movements"
          />
          <Select
            value={list.filters['direction']?.[0] ?? ''}
            onChange={(e) => list.setFilter('direction', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by direction"
          >
            <option value="">In and out</option>
            <option value="in">Incoming only</option>
            <option value="out">Outgoing only</option>
          </Select>
          <Select
            value={list.filters['reason']?.[0] ?? ''}
            onChange={(e) => list.setFilter('reason', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by reason"
          >
            <option value="">All reasons</option>
            {Object.keys(REASON_TONES).map((reason) => (
              <option key={reason} value={reason}>
                {humanize(reason)}
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
              {formatNumber(query.data.total)} movements
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(move) => move.id}
          isLoading={query.isLoading}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No movements match"
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
