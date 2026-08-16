/**
 * Products: catalogue list and product detail.
 *
 * The list joins the catalogue with the derived stock position, because "what
 * is it and how many have we got" is one question in practice. The join happens
 * in the service, not here.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys, type ProductWithStock } from '@/services';
import type { StockMove } from '@/domain';
import { Badge, Card, CardHeader, ErrorState, Field, PageHeader, SearchInput, Select, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { DocumentLink } from '@/components/domain/documents';
import { DetailGrid, DetailSkeleton, DetailTitle } from '@/components/domain/detail';
import { useListParams } from '@/hooks/useListParams';
import { cn, formatDateTime, formatNumber, humanize } from '@/lib/format';
import { subtract } from '@/lib/money';

export function ProductsPage() {
  const navigate = useNavigate();
  const list = useListParams({
    defaultSortBy: 'sku',
    defaultSortDir: 'asc',
    filterKeys: ['categoryId', 'type'],
  });

  const query = useQuery({
    queryKey: queryKeys.products(list.params),
    queryFn: () => api.inventory.listProducts(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<ProductWithStock>[] = [
    {
      key: 'sku',
      header: 'SKU',
      sortable: true,
      width: '120px',
      render: (p) => <span className="text-secondary tabular">{p.sku}</span>,
    },
    {
      key: 'name',
      header: 'Product',
      sortable: true,
      render: (p) => (
        <>
          <span className="block truncate font-medium text-primary">{p.name}</span>
          <span className="text-xs text-muted">{p.categoryName}</span>
        </>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: '110px',
      hideBelow: 'lg',
      render: (p) =>
        p.type === 'stockable' ? (
          <Badge tone="neutral">Stockable</Badge>
        ) : (
          <Badge tone="info">{humanize(p.type)}</Badge>
        ),
    },
    {
      key: 'available',
      header: 'Available',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '100px',
      render: (p) => {
        // Services hold no stock, so a quantity would be meaningless rather
        // than zero. The cell stays empty for them.
        if (p.type !== 'stockable') return null;
        return (
          <span
            className={cn(
              'font-semibold',
              p.available <= 0
                ? 'text-danger-text'
                : p.available <= p.reorderPoint
                  ? 'text-warning-text'
                  : 'text-primary',
            )}
          >
            {formatNumber(p.available)}
          </span>
        );
      },
    },
    {
      key: 'onHand',
      header: 'On hand',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '95px',
      hideBelow: 'md',
      render: (p) => (p.type === 'stockable' ? <span className="text-secondary">{formatNumber(p.onHand)}</span> : null),
    },
    {
      key: 'costPrice',
      header: 'Cost',
      align: 'right',
      numeric: true,
      width: '100px',
      hideBelow: 'xl',
      render: (p) => <MoneyText value={p.costPrice} muted />,
    },
    {
      key: 'salesPrice',
      header: 'Price',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '100px',
      render: (p) => <MoneyText value={p.salesPrice} strong />,
    },
    {
      key: 'stockValue',
      header: 'Stock value',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      hideBelow: 'lg',
      render: (p) => (p.type === 'stockable' ? <MoneyText value={p.stockValue} /> : null),
    },
  ];

  return (
    <>
      <PageHeader title="Products" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search name, SKU, barcode"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search products"
          />
          <Select
            value={list.filters['type']?.[0] ?? ''}
            onChange={(e) => list.setFilter('type', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            <option value="stockable">Stockable</option>
            <option value="service">Service</option>
            <option value="consumable">Consumable</option>
          </Select>
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} products
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(p) => p.id}
          isLoading={query.isLoading}
          onRowClick={(p) => navigate(`/inventory/products/${p.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No products match"
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

export function ProductDetailPage() {
  const { id = '' } = useParams();

  const product = useQuery({ queryKey: queryKeys.product(id), queryFn: () => api.inventory.getProduct(id) });
  const stock = useQuery({
    queryKey: queryKeys.productStock(id),
    queryFn: () => api.inventory.getProductStock(id),
  });
  const movements = useQuery({
    queryKey: queryKeys.stockMoves({ productId: id, pageSize: 25 }),
    queryFn: () => api.inventory.listMovements({ filters: { productId: [id] }, pageSize: 25 }),
  });

  if (product.isError) return <ErrorState message={(product.error as Error).message} />;
  if (product.isLoading || !product.data) return <DetailSkeleton />;

  const p = product.data;
  const margin = subtract(p.salesPrice, p.costPrice);
  const marginPct = p.salesPrice.amount > 0 ? (margin.amount / p.salesPrice.amount) * 100 : 0;

  const moveColumns: Column<StockMove>[] = [
    {
      key: 'when',
      header: 'When',
      width: '150px',
      numeric: true,
      render: (m) => <span className="text-secondary">{formatDateTime(m.occurredAt)}</span>,
    },
    { key: 'wh', header: 'Warehouse', hideBelow: 'md', render: (m) => m.warehouseName },
    {
      key: 'qty',
      header: 'Qty',
      align: 'right',
      numeric: true,
      width: '85px',
      render: (m) => (
        <span className={cn('font-semibold', m.quantity >= 0 ? 'text-success-text' : 'text-danger-text')}>
          {m.quantity >= 0 ? '+' : ''}
          {formatNumber(m.quantity)}
        </span>
      ),
    },
    { key: 'reason', header: 'Reason', width: '150px', render: (m) => humanize(m.reason) },
    {
      key: 'source',
      header: 'Source document',
      width: '160px',
      render: (m) => <DocumentLink refDoc={m.sourceDocument} showIcon />,
    },
  ];

  return (
    <>
      <PageHeader
        title={<DetailTitle backTo="/inventory/products" backLabel="Back to products" docNumber={p.name} />}
        subtitle={`${p.sku} · ${p.categoryName}`}
        meta={
          p.type !== 'stockable' ? <Badge tone="info">{humanize(p.type)}, holds no stock</Badge> : undefined
        }
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="SKU">{p.sku}</Field>
                <Field label="Barcode">{p.barcode}</Field>
                <Field label="Category">{p.categoryName}</Field>
                <Field label="Unit">{p.uom}</Field>
                <Field label="Sales price">
                  <MoneyText value={p.salesPrice} strong />
                </Field>
                <Field label="Cost price">
                  <MoneyText value={p.costPrice} />
                </Field>
                <Field label="Margin">
                  <span className={marginPct < 20 ? 'text-warning-text' : 'text-success-text'}>
                    {marginPct.toFixed(1)}%
                  </span>
                </Field>
                <Field label="Costing method">{humanize(p.costingMethod)}</Field>
              </dl>
            </Card>

            {p.type === 'stockable' && (
              <Card padded={false}>
                <CardHeader title="Stock by warehouse" />
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                        <th className="px-3 py-2 text-left">Warehouse</th>
                        <th className="px-3 py-2 text-right">On hand</th>
                        <th className="px-3 py-2 text-right">Reserved</th>
                        <th className="px-3 py-2 text-right">Available</th>
                        <th className="px-3 py-2 text-right">Incoming</th>
                        <th className="px-3 py-2 text-right">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(stock.data ?? []).map((level) => (
                        <tr key={level.warehouseId} className="border-b border-line">
                          <td className="px-3 py-2 text-primary">{level.warehouseName}</td>
                          <td className="px-3 py-2 text-right text-secondary tabular">
                            {formatNumber(level.onHand)}
                          </td>
                          <td className="px-3 py-2 text-right tabular">
                            <span className={level.reserved > 0 ? 'text-warning-text' : 'text-muted'}>
                              {formatNumber(level.reserved)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-semibold tabular">
                            {formatNumber(level.available)}
                          </td>
                          <td className="px-3 py-2 text-right tabular">
                            <span className={level.incoming > 0 ? 'text-info-text' : 'text-muted'}>
                              {level.incoming > 0 ? '+' : ''}
                              {formatNumber(level.incoming)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <MoneyText value={level.valuation} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {p.type === 'stockable' && (
              <Card padded={false}>
                <CardHeader
                  title="Movement history"
                  subtitle="Every change, and what caused it"
                  action={
                    <Link
                      to={`/inventory/movements?productId=${p.id}`}
                      className="text-xs text-accent-text hover:underline"
                    >
                      Open full ledger
                    </Link>
                  }
                />
                <DataTable
                  columns={moveColumns}
                  rows={movements.data?.rows ?? []}
                  rowKey={(m) => m.id}
                  isLoading={movements.isLoading}
                  emptyTitle="No movements recorded"
                />
              </Card>
            )}
          </>
        }
        aside={
          <>
            {p.type === 'stockable' && (
              <>
                <Card padded={false}>
                  <CardHeader title="Position" />
                  <div className="space-y-3 p-4">
                    <div>
                      <p className="text-2xl font-semibold text-primary tabular">
                        {formatNumber(p.available)}
                      </p>
                      <p className="text-xs text-muted">Available to sell across all warehouses</p>
                    </div>
                    <dl className="space-y-1.5 border-t border-line pt-3 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-secondary">On hand</dt>
                        <dd className="tabular">{formatNumber(p.onHand)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-secondary">Reserved</dt>
                        <dd className="tabular">{formatNumber(p.reserved)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-secondary">Incoming</dt>
                        <dd className="tabular">{formatNumber(p.incoming)}</dd>
                      </div>
                      <div className="flex justify-between border-t border-line pt-1.5">
                        <dt className="text-secondary">Stock value</dt>
                        <dd>
                          <MoneyText value={p.stockValue} strong />
                        </dd>
                      </div>
                    </dl>
                  </div>
                </Card>

                <Card padded={false}>
                  <CardHeader title="Reordering" />
                  <div className="space-y-2 p-4 text-sm">
                    <div className="flex justify-between">
                      <span className="text-secondary">Reorder point</span>
                      <span className="tabular">{formatNumber(p.reorderPoint)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-secondary">Reorder quantity</span>
                      <span className="tabular">{formatNumber(p.reorderQuantity)}</span>
                    </div>
                    {p.available <= p.reorderPoint && (
                      <p className="mt-2 rounded border border-warning/30 bg-warning-soft/40 px-2 py-1.5 text-xs text-warning-text">
                        Below reorder point.
                        {p.incoming > 0
                          ? ` ${formatNumber(p.incoming)} already on order.`
                          : ' Nothing on order.'}
                      </p>
                    )}
                  </div>
                </Card>
              </>
            )}

            <Card>
              <p className="text-2xs font-medium tracking-wide text-muted uppercase">Valuation</p>
              <p className="mt-1.5 text-xs text-secondary">
                Stock is valued at {humanize(p.costingMethod)} cost. The costing method is an
                accounting decision: it changes reported profit, so it is owned by the ledger rather
                than by the catalogue.
              </p>
            </Card>
          </>
        }
      />
    </>
  );
}
