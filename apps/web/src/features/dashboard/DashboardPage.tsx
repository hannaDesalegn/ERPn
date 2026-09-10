/**
 * Operational dashboard.
 *
 * STRUCTURE, in the order a manager reads it:
 *   1. KPI row      — the state of the business in eight numbers
 *   2. Needs attention — the work queue: what is blocked on a human
 *   3. Trends       — is the direction good, over 30 days
 *   4. Money owed   — receivables and payables aging, side by side
 *   5. Cash + stock — liquidity and the goods that back it
 *   6. Activity     — what colleagues have been doing
 *
 * The "needs attention" panel is deliberately near the top and above the
 * charts. Charts describe the past; the action list is the only part of the
 * page that changes what happens today.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import { Badge, Card, CardHeader, EmptyState, ErrorState, Icon, PageHeader, Skeleton } from '@/components/ui';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { ActivityTimeline, DocumentLink } from '@/components/domain/documents';
import { TrendChart } from '@/components/charts/TrendChart';
import { AgingBars } from '@/components/charts/AgingBars';
import { useSession } from '@/app/session';
import type { ActionItem, Kpi, Money } from '@/domain';
import { formatMoney, sum } from '@/lib/money';
import { cn, formatDate, formatNumber, formatPercent } from '@/lib/format';
import { todayISO } from '@/lib/clock';

function isMoney(value: Money | number): value is Money {
  return typeof value === 'object' && 'amount' in value;
}

// ---------------------------------------------------------------------------
// KPI tile
// ---------------------------------------------------------------------------

function KpiTile({ kpi }: { kpi: Kpi }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-1">
        <p className="text-xs font-medium text-secondary">{kpi.label}</p>
        {/* Neutral info affordance. This previously used the warning triangle,
            which is the same glyph as a critical action item, so eight KPI
            tiles read as eight problems. */}
        <span
          className="cursor-help text-muted transition-colors hover:text-secondary"
          title={kpi.help}
          aria-label={kpi.help}
        >
          <Icon name="info" className="size-3.5" />
        </span>
      </div>

      <p className="mt-1.5 text-xl font-semibold text-primary tabular">
        {isMoney(kpi.value) ? formatMoney(kpi.value) : formatNumber(kpi.value)}
      </p>

      {kpi.changePercent !== undefined && (
        <p className="mt-1 flex items-center gap-1 text-xs">
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium',
              // "Good" depends on the metric, not on the sign. Rising payables
              // is not an improvement, so each KPI declares its own direction.
              (kpi.changePercent >= 0) === kpi.higherIsBetter
                ? 'text-success-text'
                : 'text-danger-text',
            )}
          >
            <Icon name={kpi.changePercent >= 0 ? 'arrowUp' : 'arrowDown'} className="size-3" />
            {formatPercent(Math.abs(kpi.changePercent))}
          </span>
          <span className="text-muted">vs last month</span>
        </p>
      )}
    </>
  );

  return kpi.href ? (
    <Link
      to={kpi.href}
      className="rounded-lg border border-line bg-surface p-3 transition-colors hover:border-line-strong hover:bg-hover"
    >
      {body}
    </Link>
  ) : (
    <div className="rounded-lg border border-line bg-surface p-3">{body}</div>
  );
}

// ---------------------------------------------------------------------------
// Action item row
// ---------------------------------------------------------------------------

const SEVERITY_STYLES = {
  critical: { tone: 'danger' as const, icon: 'alert' as const, label: 'Critical' },
  warning: { tone: 'warning' as const, icon: 'clock' as const, label: 'Action' },
  info: { tone: 'info' as const, icon: 'link' as const, label: 'Review' },
};

function ActionRow({ item }: { item: ActionItem }) {
  const style = SEVERITY_STYLES[item.severity];
  return (
    <li>
      <Link
        to={item.href}
        className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover"
      >
        <span
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-full',
            item.severity === 'critical' && 'bg-danger-soft text-danger-text',
            item.severity === 'warning' && 'bg-warning-soft text-warning-text',
            item.severity === 'info' && 'bg-info-soft text-info-text',
          )}
        >
          <Icon name={style.icon} className="size-3" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-primary">{item.title}</span>
          <span className="block truncate text-xs text-muted">{item.detail}</span>
        </span>

        {item.amount && <MoneyText value={item.amount} className="text-sm" strong />}
        <Icon name="chevronRight" className="size-3.5 shrink-0 text-muted" />
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------

export function DashboardPage() {
  const { activeCompany, can } = useSession();
  const navigate = useNavigate();

  const dashboard = useQuery({ queryKey: queryKeys.dashboard, queryFn: api.dashboard.get });
  const activity = useQuery({ queryKey: queryKeys.recentActivity, queryFn: () => api.admin.recentActivity(8) });
  const recentSales = useQuery({ queryKey: ['dashboard', 'recent-sales'], queryFn: () => api.sales.recentOrders(5) });
  const recentPurchases = useQuery({
    queryKey: ['dashboard', 'recent-purchases'],
    queryFn: () => api.purchasing.recentOrders(5),
  });

  if (dashboard.isError) {
    return <ErrorState message={(dashboard.error as Error).message} onRetry={() => dashboard.refetch()} />;
  }

  const data = dashboard.data;
  const receivablesTotal = data ? sum(data.receivablesAging.map((b) => b.amount)) : undefined;
  const payablesTotal = data ? sum(data.payablesAging.map((b) => b.amount)) : undefined;

  // Financial figures are hidden from roles that have no business seeing them.
  // A warehouse operator gets the operational half of this page and nothing more.
  const showFinancials = can('reports:financial') || can('accounting:view');

  return (
    <>
      <PageHeader
        title="Dashboard"
        // The company being looked at, which matters in a product where one person reaches
        // several. The job title this used to show came from a fixture user and the server
        // does not send one, so inventing it here is exactly what this increment removes.
        subtitle={activeCompany.name}
        meta={<span className="text-xs text-muted">As at {formatDate(todayISO())}</span>}
      />

      {/* 1. KPIs -------------------------------------------------------- */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {dashboard.isLoading
          ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[86px] rounded-lg" />)
          : data?.kpis
              .filter((kpi) => showFinancials || ['sales_today', 'sales_month', 'inventory_value'].includes(kpi.key))
              .map((kpi) => <KpiTile key={kpi.key} kpi={kpi} />)}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 2. Needs attention ------------------------------------------- */}
        <Card className="xl:col-span-2" padded={false}>
          <CardHeader
            title="Needs attention"
            action={
              data?.actionItems.length ? (
                <Badge tone={data.actionItems.some((i) => i.severity === 'critical') ? 'danger' : 'warning'}>
                  {data.actionItems.length} open
                </Badge>
              ) : undefined
            }
          />
          {dashboard.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : data?.actionItems.length ? (
            <ul className="max-h-96 divide-y divide-[var(--border)] overflow-y-auto">
              {data.actionItems.slice(0, 10).map((item) => (
                <ActionRow key={item.id} item={item} />
              ))}
            </ul>
          ) : (
            <EmptyState icon="check" title="Nothing needs attention" description="No approvals, overdue invoices or stock alerts." />
          )}
        </Card>

        {/* 5a. Cash ------------------------------------------------------ */}
        {showFinancials && (
          <Card padded={false}>
            <CardHeader title="Cash & bank" />
            {dashboard.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : (
              <div className="p-4">
                <p className="text-2xl font-semibold text-primary tabular">
                  {data && formatMoney(data.cash.total)}
                </p>
                <p className="mt-0.5 text-xs text-muted">Total available</p>
                <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
                  {data?.cash.accounts.map((account) => (
                    <li key={account.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-secondary">{account.name}</span>
                      <MoneyText value={account.balance} />
                    </li>
                  ))}
                </ul>
                {/* Comparing cash against near-term obligations is the whole
                    point of showing them together. */}
                {payablesTotal && (
                  <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                    Against{' '}
                    <span className="font-medium text-secondary">{formatMoney(payablesTotal)}</span>{' '}
                    owed to suppliers
                  </p>
                )}
              </div>
            )}
          </Card>
        )}

        {/* 3. Trends ------------------------------------------------------ */}
        <Card padded={false} className="xl:col-span-2">
          <CardHeader title="Sales" subtitle="Last 30 days, net of tax" />
          <div className="p-3">
            {dashboard.isLoading ? (
              <Skeleton className="h-44" />
            ) : (
              <TrendChart points={data!.salesTrend.points} ariaLabel="Daily sales value over the last 30 days" />
            )}
          </div>
        </Card>

        <Card padded={false}>
          <CardHeader title="Purchases" subtitle="Last 30 days, approved orders" />
          <div className="p-3">
            {dashboard.isLoading ? (
              <Skeleton className="h-44" />
            ) : (
              <TrendChart points={data!.purchaseTrend.points} ariaLabel="Daily purchase value over the last 30 days" />
            )}
          </div>
        </Card>

        {/* 4. Aging ------------------------------------------------------- */}
        {showFinancials && (
          <>
            <Card padded={false}>
              <CardHeader
                title="Owed to us"
                subtitle="Receivables by age"
                action={
                  <Link to="/sales/invoices" className="text-xs text-accent-text hover:underline">
                    View invoices
                  </Link>
                }
              />
              <div className="p-4">
                {dashboard.isLoading ? (
                  <Skeleton className="h-32" />
                ) : (
                  <AgingBars bands={data!.receivablesAging} total={receivablesTotal!} emptyLabel="No outstanding receivables" />
                )}
              </div>
            </Card>

            <Card padded={false}>
              <CardHeader
                title="We owe"
                subtitle="Payables by age"
                action={
                  <Link to="/purchasing/bills" className="text-xs text-accent-text hover:underline">
                    View bills
                  </Link>
                }
              />
              <div className="p-4">
                {dashboard.isLoading ? (
                  <Skeleton className="h-32" />
                ) : (
                  <AgingBars bands={data!.payablesAging} total={payablesTotal!} emptyLabel="No outstanding payables" />
                )}
              </div>
            </Card>
          </>
        )}

        {/* 5b. Low stock -------------------------------------------------- */}
        <Card padded={false} className={showFinancials ? '' : 'xl:col-span-2'}>
          <CardHeader
            title="Low stock"
            subtitle="Below reorder point"
            action={
              <Link to="/inventory/stock" className="text-xs text-accent-text hover:underline">
                View stock
              </Link>
            }
          />
          {dashboard.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : data?.lowStock.length ? (
            <ul className="divide-y divide-[var(--border)]">
              {data.lowStock.slice(0, 6).map((alert) => (
                <li
                  key={`${alert.productId}-${alert.warehouseName}`}
                  className="flex items-center gap-2 px-4 py-2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-primary">{alert.productName}</span>
                    <span className="block text-xs text-muted">
                      {alert.productSku} · {alert.warehouseName}
                    </span>
                  </span>
                  <span className="text-right">
                    <span
                      className={cn(
                        'block text-sm font-medium tabular',
                        alert.available <= 0 ? 'text-danger-text' : 'text-warning-text',
                      )}
                    >
                      {formatNumber(alert.available)}
                    </span>
                    <span className="block text-2xs text-muted tabular">of {alert.reorderPoint}</span>
                  </span>
                  {/* A shortfall already covered by an incoming PO needs no
                      decision, so it is visually de-emphasised rather than hidden. */}
                  {alert.covered ? (
                    <Badge tone="info">On order</Badge>
                  ) : (
                    <Badge tone="warning">Reorder</Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="check" title="Stock levels healthy" />
          )}
        </Card>

        {/* Recent documents ---------------------------------------------- */}
        <Card padded={false}>
          <CardHeader
            title="Recent sales orders"
            action={
              <Link to="/sales/orders" className="text-xs text-accent-text hover:underline">
                All orders
              </Link>
            }
          />
          {recentSales.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {recentSales.data?.map((order) => (
                <li
                  key={order.id}
                  onClick={() => navigate(`/sales/orders/${order.id}`)}
                  className="flex cursor-pointer items-center gap-2 px-4 py-2 hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <DocumentLink refDoc={{ id: order.id, docType: 'sales_order', docNumber: order.docNumber }} className="text-sm" />
                    <span className="block truncate text-xs text-muted">{order.customer.name}</span>
                  </span>
                  <MoneyText value={order.total} className="text-sm" />
                  <StatusBadge status={order.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card padded={false}>
          <CardHeader
            title="Recent purchase orders"
            action={
              <Link to="/purchasing/orders" className="text-xs text-accent-text hover:underline">
                All orders
              </Link>
            }
          />
          {recentPurchases.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-[var(--border)]">
              {recentPurchases.data?.map((order) => (
                <li
                  key={order.id}
                  onClick={() => navigate(`/purchasing/orders/${order.id}`)}
                  className="flex cursor-pointer items-center gap-2 px-4 py-2 hover:bg-hover"
                >
                  <span className="min-w-0 flex-1">
                    <DocumentLink refDoc={{ id: order.id, docType: 'purchase_order', docNumber: order.docNumber }} className="text-sm" />
                    <span className="block truncate text-xs text-muted">{order.supplier.name}</span>
                  </span>
                  <MoneyText value={order.total} className="text-sm" />
                  <StatusBadge status={order.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 6. Activity ---------------------------------------------------- */}
        <Card padded={false} className="xl:col-span-3">
          <CardHeader
            title="Recent activity"
            action={
              <Link to="/admin/audit" className="text-xs text-accent-text hover:underline">
                Full audit log
              </Link>
            }
          />
          {activity.isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : (
            <ActivityTimeline events={activity.data ?? []} compact />
          )}
        </Card>
      </div>
    </>
  );
}
