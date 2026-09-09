/**
 * Deliveries and goods receipts.
 *
 * These are the two documents that move physical stock, so they are the two
 * that write to the movement ledger. Both show ordered against actual, because
 * the difference between what was promised and what moved is the whole reason
 * they exist as separate documents rather than a flag on the order.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { Delivery, GoodsReceipt } from '@/domain';
import { Badge, Card, CardHeader, ErrorState, Field, PageHeader, SearchInput, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { DetailGrid, DetailSkeleton, DetailTitle, HistoryPanel, RelatedPanel } from '@/components/domain/detail';
import { useListParams } from '@/hooks/useListParams';
import { cn, formatDate, formatNumber, formatQuantity } from '@/lib/format';

// ===========================================================================
// Deliveries
// ===========================================================================

export function DeliveriesPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'shippedDate', filterKeys: ['status', 'warehouseId'] });

  const query = useQuery({
    queryKey: queryKeys.deliveries(list.params),
    queryFn: () => api.sales.listDeliveries(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<Delivery>[] = [
    {
      key: 'docNumber',
      header: 'Delivery',
      sortable: true,
      width: '140px',
      render: (d) => <span className="font-medium text-accent-text">{d.docNumber}</span>,
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (d) => <span className="truncate text-primary">{d.customer.name}</span>,
    },
    {
      key: 'order',
      header: 'Order',
      width: '130px',
      hideBelow: 'md',
      render: (d) => <span className="text-secondary tabular">{d.salesOrderNumber}</span>,
    },
    {
      key: 'warehouse',
      header: 'From',
      hideBelow: 'xl',
      render: (d) => <span className="text-secondary">{d.warehouseName}</span>,
    },
    {
      key: 'shippedDate',
      header: 'Shipped',
      sortable: true,
      width: '110px',
      numeric: true,
      render: (d) => <span className="text-secondary">{formatDate(d.shippedDate)}</span>,
    },
    {
      key: 'carrier',
      header: 'Carrier',
      width: '130px',
      hideBelow: 'lg',
      render: (d) => <span className="text-secondary">{d.carrier}</span>,
    },
    {
      /** Fully shipped, or short. The reason this document is separate. */
      key: 'complete',
      header: 'Shipped',
      align: 'right',
      numeric: true,
      width: '100px',
      render: (d) => {
        const ordered = d.lines.reduce((a, l) => a + l.orderedQuantity, 0);
        const shipped = d.lines.reduce((a, l) => a + l.shippedQuantity, 0);
        const full = shipped >= ordered;
        return (
          <span className={full ? 'text-success-text' : 'text-warning-text'}>
            {formatQuantity(shipped)} / {formatQuantity(ordered)}
          </span>
        );
      },
    },
    { key: 'status', header: 'Status', width: '120px', render: (d) => <StatusBadge status={d.status} /> },
  ];

  return (
    <>
      <PageHeader title="Deliveries" subtitle="Goods shipped to customers" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search delivery, customer, tracking"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search deliveries"
          />
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} deliveries
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(d) => d.id}
          isLoading={query.isLoading}
          onRowClick={(d) => navigate(`/sales/deliveries/${d.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No deliveries match"
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

export function DeliveryDetailPage() {
  const { id = '' } = useParams();
  const delivery = useQuery({ queryKey: queryKeys.delivery(id), queryFn: () => api.sales.getDelivery(id) });

  if (delivery.isError) return <ErrorState message={(delivery.error as Error).message} />;
  if (delivery.isLoading || !delivery.data) return <DetailSkeleton />;

  const d = delivery.data;
  const short = d.lines.some((l) => l.shippedQuantity < l.orderedQuantity);

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/sales/deliveries"
            backLabel="Back to deliveries"
            docNumber={d.docNumber}
            status={d.status}
          />
        }
        subtitle={`${d.customer.name} · shipped ${formatDate(d.shippedDate)}`}
        meta={short ? <Badge tone="warning">Partial shipment</Badge> : undefined}
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Shipment details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Customer">
                  <Link to={`/sales/customers/${d.customer.id}`} className="text-accent-text hover:underline">
                    {d.customer.name}
                  </Link>
                </Field>
                <Field label="Sales order">
                  <Link to={`/sales/orders/${d.salesOrderId}`} className="text-accent-text hover:underline">
                    {d.salesOrderNumber}
                  </Link>
                </Field>
                <Field label="From warehouse">{d.warehouseName}</Field>
                <Field label="Scheduled">{formatDate(d.scheduledDate)}</Field>
                <Field label="Shipped">{formatDate(d.shippedDate)}</Field>
                <Field label="Carrier">{d.carrier}</Field>
                <Field label="Tracking">{d.trackingNumber}</Field>
                <Field label="Picked by">{d.createdBy.name}</Field>
              </dl>
            </Card>

            <Card padded={false}>
              <CardHeader title="Lines" subtitle={`${d.lines.length} products`} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                      <th className="px-3 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-right">Ordered</th>
                      <th className="px-3 py-2 text-right">Shipped</th>
                      <th className="px-3 py-2 text-right">Outstanding</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines.map((line) => {
                      const outstanding = line.orderedQuantity - line.shippedQuantity;
                      return (
                        <tr key={line.id} className="border-b border-line">
                          <td className="px-3 py-2">
                            <Link
                              to={`/inventory/products/${line.productId}`}
                              className="block truncate text-primary hover:text-accent-text hover:underline"
                            >
                              {line.productName}
                            </Link>
                            <span className="text-xs text-muted">{line.productSku}</span>
                          </td>
                          <td className="px-3 py-2 text-right text-secondary tabular">
                            {formatQuantity(line.orderedQuantity)}
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-primary tabular">
                            {formatQuantity(line.shippedQuantity)}
                          </td>
                          <td className="px-3 py-2 text-right tabular">
                            <span className={cn(outstanding > 0 ? 'text-warning-text' : 'text-muted')}>
                              {formatQuantity(outstanding)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        }
        aside={
          <>
            <RelatedPanel links={d.links} />
            <HistoryPanel targetId={d.id} />
            <Card>
              <p className="text-2xs font-medium tracking-wide text-muted uppercase">Stock effect</p>
              <p className="mt-1.5 text-xs text-secondary">
                Shipping wrote a negative stock movement for each line and moved their cost out of
                Inventory into Cost of Goods Sold. Revenue is recognised separately, when the invoice
                is posted.
              </p>
              <Link
                to={`/inventory/movements?q=${d.docNumber}`}
                className="mt-2 block text-xs text-accent-text hover:underline"
              >
                View the movements this created
              </Link>
            </Card>
          </>
        }
      />
    </>
  );
}

// ===========================================================================
// Goods receipts
// ===========================================================================

export function GoodsReceiptsPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'receivedDate', filterKeys: ['status', 'warehouseId'] });

  const query = useQuery({
    queryKey: queryKeys.goodsReceipts(list.params),
    queryFn: () => api.purchasing.listReceipts(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<GoodsReceipt>[] = [
    {
      key: 'docNumber',
      header: 'Receipt',
      sortable: true,
      width: '140px',
      render: (r) => <span className="font-medium text-accent-text">{r.docNumber}</span>,
    },
    {
      key: 'supplier',
      header: 'Supplier',
      render: (r) => <span className="truncate text-primary">{r.supplier.name}</span>,
    },
    {
      key: 'po',
      header: 'Order',
      width: '130px',
      hideBelow: 'md',
      render: (r) => <span className="text-secondary tabular">{r.purchaseOrderNumber}</span>,
    },
    {
      key: 'receivedDate',
      header: 'Received',
      sortable: true,
      width: '110px',
      numeric: true,
      render: (r) => <span className="text-secondary">{formatDate(r.receivedDate)}</span>,
    },
    {
      key: 'warehouse',
      header: 'Into',
      hideBelow: 'lg',
      render: (r) => <span className="text-secondary">{r.warehouseName}</span>,
    },
    {
      /** Rejected on inspection. Arrived, but never entered sellable stock. */
      key: 'rejected',
      header: 'Rejected',
      align: 'right',
      numeric: true,
      width: '95px',
      render: (r) => {
        const rejected = r.lines.reduce((a, l) => a + l.rejectedQuantity, 0);
        return rejected > 0 ? (
          <span className="font-medium text-danger-text">{formatQuantity(rejected)}</span>
        ) : (
          <span className="text-muted">0</span>
        );
      },
    },
    { key: 'status', header: 'Status', width: '120px', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <>
      <PageHeader title="Goods receipts" subtitle="What physically arrived from suppliers" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search receipt, supplier, delivery note"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search goods receipts"
          />
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} receipts
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(r) => r.id}
          isLoading={query.isLoading}
          onRowClick={(r) => navigate(`/purchasing/receipts/${r.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No goods receipts match"
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

export function GoodsReceiptDetailPage() {
  const { id = '' } = useParams();
  const receipt = useQuery({ queryKey: queryKeys.goodsReceipt(id), queryFn: () => api.purchasing.getReceipt(id) });

  if (receipt.isError) return <ErrorState message={(receipt.error as Error).message} />;
  if (receipt.isLoading || !receipt.data) return <DetailSkeleton />;

  const r = receipt.data;
  const totalRejected = r.lines.reduce((a, l) => a + l.rejectedQuantity, 0);
  const short = r.lines.some((l) => l.receivedQuantity < l.orderedQuantity);

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/purchasing/receipts"
            backLabel="Back to goods receipts"
            docNumber={r.docNumber}
            status={r.status}
          />
        }
        subtitle={`${r.supplier.name} · received ${formatDate(r.receivedDate)}`}
        meta={
          <>
            {short && <Badge tone="warning">Short delivery</Badge>}
            {totalRejected > 0 && <Badge tone="danger">{formatQuantity(totalRejected)} rejected</Badge>}
          </>
        }
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Receipt details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Supplier">
                  <Link
                    to={`/purchasing/suppliers/${r.supplier.id}`}
                    className="text-accent-text hover:underline"
                  >
                    {r.supplier.name}
                  </Link>
                </Field>
                <Field label="Purchase order">
                  <Link
                    to={`/purchasing/orders/${r.purchaseOrderId}`}
                    className="text-accent-text hover:underline"
                  >
                    {r.purchaseOrderNumber}
                  </Link>
                </Field>
                <Field label="Received into">{r.warehouseName}</Field>
                <Field label="Received on">{formatDate(r.receivedDate)}</Field>
                <Field label="Received by">{r.receivedBy.name}</Field>
                <Field label="Their delivery note">{r.supplierDeliveryNote}</Field>
              </dl>
            </Card>

            <Card padded={false}>
              <CardHeader title="Lines" subtitle={`${r.lines.length} products`} />
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                      <th className="px-3 py-2 text-left">Product</th>
                      <th className="px-3 py-2 text-right">Ordered</th>
                      <th className="px-3 py-2 text-right">Received</th>
                      <th className="px-3 py-2 text-right">Rejected</th>
                      <th className="px-3 py-2 text-right">Into stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lines.map((line) => {
                      const good = line.receivedQuantity - line.rejectedQuantity;
                      return (
                        <tr key={line.id} className="border-b border-line">
                          <td className="px-3 py-2">
                            <Link
                              to={`/inventory/products/${line.productId}`}
                              className="block truncate text-primary hover:text-accent-text hover:underline"
                            >
                              {line.productName}
                            </Link>
                            <span className="text-xs text-muted">{line.productSku}</span>
                          </td>
                          <td className="px-3 py-2 text-right text-secondary tabular">
                            {formatQuantity(line.orderedQuantity)}
                          </td>
                          <td className="px-3 py-2 text-right text-primary tabular">
                            {formatQuantity(line.receivedQuantity)}
                          </td>
                          <td className="px-3 py-2 text-right tabular">
                            <span className={line.rejectedQuantity > 0 ? 'text-danger-text' : 'text-muted'}>
                              {formatQuantity(line.rejectedQuantity)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-semibold text-primary tabular">
                            {formatQuantity(good)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="border-t border-line px-4 py-2.5 text-xs text-muted">
                Only the accepted quantity enters stock. Rejected units arrived but were never
                received into inventory, so they are not billable.
              </p>
            </Card>
          </>
        }
        aside={
          <>
            <RelatedPanel links={r.links} />
            <HistoryPanel targetId={r.id} />
            <Card>
              <p className="text-2xs font-medium tracking-wide text-muted uppercase">Stock effect</p>
              <p className="mt-1.5 text-xs text-secondary">
                This receipt wrote a positive stock movement per accepted line and increased the
                Inventory account by their cost.
              </p>
              <Link
                to={`/inventory/movements?q=${r.docNumber}`}
                className="mt-2 block text-xs text-accent-text hover:underline"
              >
                View the movements this created
              </Link>
            </Card>
          </>
        }
      />
    </>
  );
}
