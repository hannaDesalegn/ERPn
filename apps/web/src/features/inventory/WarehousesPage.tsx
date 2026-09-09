/**
 * Warehouses and inventory adjustments.
 *
 * Warehouse totals come from the service, aggregated over the whole stock set.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { InventoryAdjustment } from '@/domain';
import { Badge, Card, CardHeader, ErrorState, Field, Icon, PageHeader, Skeleton } from '@/components/ui';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { DetailGrid, DetailSkeleton, DetailTitle, HistoryPanel, RelatedPanel } from '@/components/domain/detail';
import { cn, formatDate, formatNumber, humanize } from '@/lib/format';

export function WarehousesPage() {
  const warehouses = useQuery({
    queryKey: queryKeys.warehouseStats,
    queryFn: api.inventory.listWarehousesWithStats,
  });
  const adjustments = useQuery({ queryKey: queryKeys.adjustments, queryFn: api.inventory.listAdjustments });

  return (
    <>
      <PageHeader title="Warehouses" />

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        {warehouses.isLoading
          ? [0, 1].map((i) => <Skeleton key={i} className="h-40 rounded-lg" />)
          : warehouses.data?.map((w) => (
              <Card key={w.id} padded={false}>
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      {w.name}
                      {w.isDefault && <Badge tone="accent">Default</Badge>}
                    </span>
                  }
                  subtitle={`${w.code} · ${w.city}, ${w.country}`}
                  action={
                    <Link
                      to={`/inventory/stock?warehouseId=${w.id}`}
                      className="text-xs text-accent-text hover:underline"
                    >
                      View stock
                    </Link>
                  }
                />
                <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                  <Field label="Stock value">
                    <MoneyText value={w.stockValue} strong />
                  </Field>
                  <Field label="SKUs held">{formatNumber(w.skuCount)}</Field>
                  <Field label="Units on hand">{formatNumber(w.unitsOnHand)}</Field>
                  <Field label="Below reorder">
                    <span className={w.lowStockCount > 0 ? 'text-warning-text' : undefined}>
                      {formatNumber(w.lowStockCount)}
                    </span>
                  </Field>
                </dl>
              </Card>
            ))}
      </div>

      <Card padded={false}>
        <CardHeader
          title="Inventory adjustments"
          subtitle="Corrections recorded after a physical count"
        />
        {adjustments.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {adjustments.data?.map((adj) => (
              <li key={adj.id}>
                <Link
                  to={`/inventory/adjustments/${adj.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-accent-text">{adj.docNumber}</span>
                    <span className="block truncate text-xs text-muted">
                      {adj.warehouseName} · {humanize(adj.reason)}
                    </span>
                  </span>
                  <span className="text-xs text-muted tabular">{adj.lines.length} lines</span>
                  <span className="hidden w-24 text-right text-xs text-muted tabular sm:block">
                    {formatDate(adj.countDate)}
                  </span>
                  <StatusBadge status={adj.status} />
                  <Icon name="chevronRight" className="size-3.5 shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/*
        Warehouse-to-warehouse transfers are intentionally absent. The type
        exists but the workflow is not defined well enough to build against:
        see the stock transfers placeholder.
      */}
    </>
  );
}

// ===========================================================================

export function AdjustmentDetailPage() {
  const { id = '' } = useParams();
  const adjustment = useQuery({
    queryKey: queryKeys.adjustment(id),
    queryFn: () => api.inventory.getAdjustment(id),
  });

  if (adjustment.isError) return <ErrorState message={(adjustment.error as Error).message} />;
  if (adjustment.isLoading || !adjustment.data) return <DetailSkeleton />;

  const adj: InventoryAdjustment = adjustment.data;
  const shortages = adj.lines.filter((l) => l.difference < 0);
  const surpluses = adj.lines.filter((l) => l.difference > 0);

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/inventory/warehouses"
            backLabel="Back to warehouses"
            docNumber={adj.docNumber}
            status={adj.status}
          />
        }
        subtitle={`${adj.warehouseName} · counted ${formatDate(adj.countDate)}`}
        meta={<Badge tone="neutral">{humanize(adj.reason)}</Badge>}
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Count details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Warehouse">{adj.warehouseName}</Field>
                <Field label="Count date">{formatDate(adj.countDate)}</Field>
                <Field label="Reason">{humanize(adj.reason)}</Field>
                <Field label="Counted by">{adj.createdBy.name}</Field>
              </dl>
              {adj.notes && (
                <p className="border-t border-line px-4 py-3 text-sm text-secondary">{adj.notes}</p>
              )}
            </Card>

            <Card padded={false}>
              <CardHeader
                title="Variances"
                subtitle={`${adj.lines.length} lines counted`}
              />
              {adj.lines.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-muted">
                  No line detail recorded. This document carries the opening balances migrated at
                  go-live.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                        <th className="px-3 py-2 text-left">Product</th>
                        <th className="px-3 py-2 text-right">System said</th>
                        <th className="px-3 py-2 text-right">Counted</th>
                        <th className="px-3 py-2 text-right">Variance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {adj.lines.map((line) => (
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
                            {formatNumber(line.systemQuantity)}
                          </td>
                          <td className="px-3 py-2 text-right text-primary tabular">
                            {formatNumber(line.countedQuantity)}
                          </td>
                          <td className="px-3 py-2 text-right tabular">
                            <span
                              className={cn(
                                'font-semibold',
                                line.difference < 0 ? 'text-danger-text' : 'text-success-text',
                              )}
                            >
                              {line.difference > 0 ? '+' : ''}
                              {formatNumber(line.difference)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        }
        aside={
          <>
            <Card padded={false}>
              <CardHeader title="Result" />
              <div className="space-y-2 p-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-secondary">Lines short</span>
                  <span className="font-medium text-danger-text tabular">{shortages.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-secondary">Lines over</span>
                  <span className="font-medium text-success-text tabular">{surpluses.length}</span>
                </div>
              </div>
            </Card>

            <RelatedPanel links={adj.links} />
            <HistoryPanel targetId={adj.id} />

            <Card>
              <p className="flex items-center gap-1.5 text-2xs font-medium tracking-wide text-muted uppercase">
                <Icon name="ledger" className="size-3" />
                Why this is a document
              </p>
              <p className="mt-1.5 text-xs text-secondary">
                Stock is never edited directly. A count difference is recorded as an adjustment,
                which writes its own stock movements and charges the lost value to inventory
                shrinkage. Both the mistake and the correction stay visible.
              </p>
            </Card>
          </>
        }
      />
    </>
  );
}
