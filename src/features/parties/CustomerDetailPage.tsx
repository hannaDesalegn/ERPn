/**
 * Customer detail.
 *
 * Built around the credit relationship rather than the contact card. The aging
 * profile is the first thing shown because it is what a credit controller acts
 * on: a customer owing money that is 90 days late is a different problem from
 * one owing the same amount not yet due.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import { Badge, Card, CardHeader, ErrorState, Field, PageHeader, Tabs } from '@/components/ui';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { DetailGrid, DetailSkeleton, DetailTitle, HistoryPanel } from '@/components/domain/detail';
import { AgingBars } from '@/components/charts/AgingBars';
import type { AgingBand, CustomerInvoice, Payment, SalesOrder } from '@/domain';
import { cn, daysUntil, formatDate } from '@/lib/format';

type TabKey = 'orders' | 'invoices' | 'payments';

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState<TabKey>('invoices');

  const customer = useQuery({
    queryKey: queryKeys.customer(id),
    queryFn: () => api.parties.getCustomer(id),
  });

  const activity = useQuery({
    queryKey: queryKeys.customerActivity(id),
    queryFn: () => api.parties.getCustomerActivity(id),
  });

  if (customer.isError) {
    return <ErrorState message={(customer.error as Error).message} />;
  }
  if (customer.isLoading || !customer.data) return <DetailSkeleton />;

  const c = customer.data;
  const aging = activity.data?.aging;
  const creditPct = (c.balance.amount / Math.max(1, c.creditLimit.amount)) * 100;

  // The service returns per-party aging; reshape it into the band list the
  // chart takes. The figures themselves are not recomputed here.
  const bands: AgingBand[] = aging
    ? [
        { bucket: 'current', label: 'Not yet due', amount: aging.current },
        { bucket: '1_30', label: '1 to 30 days', amount: aging.d1_30 },
        { bucket: '31_60', label: '31 to 60 days', amount: aging.d31_60 },
        { bucket: '61_90', label: '61 to 90 days', amount: aging.d61_90 },
        { bucket: '90_plus', label: '90+ days', amount: aging.d90_plus },
      ]
    : [];

  const orderColumns: Column<SalesOrder>[] = [
    {
      key: 'docNumber',
      header: 'Order',
      width: '130px',
      render: (o) => <span className="font-medium text-accent-text">{o.docNumber}</span>,
    },
    { key: 'date', header: 'Date', width: '110px', numeric: true, render: (o) => formatDate(o.orderDate) },
    { key: 'wh', header: 'Warehouse', hideBelow: 'md', render: (o) => o.warehouseName },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      numeric: true,
      width: '110px',
      render: (o) => <MoneyText value={o.total} />,
    },
    { key: 'status', header: 'Status', width: '140px', render: (o) => <StatusBadge status={o.status} /> },
  ];

  const invoiceColumns: Column<CustomerInvoice>[] = [
    {
      key: 'docNumber',
      header: 'Invoice',
      width: '140px',
      render: (i) => <span className="font-medium text-accent-text">{i.docNumber}</span>,
    },
    { key: 'date', header: 'Issued', width: '105px', numeric: true, render: (i) => formatDate(i.invoiceDate) },
    {
      key: 'due',
      header: 'Due',
      width: '130px',
      numeric: true,
      render: (i) => {
        const days = daysUntil(i.dueDate);
        const overdue = days < 0 && i.balanceDue.amount > 0;
        return (
          <span className={cn(overdue && 'text-danger-text')}>
            {formatDate(i.dueDate)}
            {overdue && <span className="ml-1 text-2xs">({-days}d late)</span>}
          </span>
        );
      },
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      numeric: true,
      width: '110px',
      render: (i) => <MoneyText value={i.total} />,
    },
    {
      key: 'due2',
      header: 'Outstanding',
      align: 'right',
      numeric: true,
      width: '115px',
      render: (i) => (
        <MoneyText value={i.balanceDue} strong className={i.balanceDue.amount > 0 ? 'text-danger-text' : ''} />
      ),
    },
    { key: 'status', header: 'Status', width: '130px', render: (i) => <StatusBadge status={i.status} /> },
  ];

  const paymentColumns: Column<Payment>[] = [
    {
      key: 'docNumber',
      header: 'Payment',
      width: '140px',
      render: (p) => <span className="font-medium text-accent-text">{p.docNumber}</span>,
    },
    { key: 'date', header: 'Date', width: '110px', numeric: true, render: (p) => formatDate(p.paymentDate) },
    { key: 'method', header: 'Method', hideBelow: 'md', render: (p) => p.method.replace(/_/g, ' ') },
    { key: 'account', header: 'Account', hideBelow: 'lg', render: (p) => p.cashAccountName },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      numeric: true,
      width: '115px',
      render: (p) => <MoneyText value={p.amount} strong />,
    },
  ];

  return (
    <>
      <PageHeader
        title={<DetailTitle backTo="/sales/customers" backLabel="Back to customers" docNumber={c.name} />}
        subtitle={`${c.code} · ${c.address?.city}, ${c.address?.country}`}
        meta={
          !c.active ? <Badge tone="neutral">Archived</Badge> : undefined
        }
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Code">{c.code}</Field>
                <Field label="Tax ID">{c.taxId}</Field>
                <Field label="Payment terms">{c.paymentTerms.label}</Field>
                <Field label="Due after">{c.paymentTerms.daysUntilDue} days</Field>
                <Field label="Email">{c.email}</Field>
                <Field label="Phone">{c.phone}</Field>
                <Field label="Address">{c.address?.line1}</Field>
                <Field label="Country">{c.address?.country}</Field>
              </dl>
            </Card>

            <Card padded={false}>
              <Tabs
                tabs={[
                  { key: 'invoices', label: 'Invoices', count: activity.data?.invoices.length },
                  { key: 'orders', label: 'Orders', count: activity.data?.orders.length },
                  { key: 'payments', label: 'Payments', count: activity.data?.payments.length },
                ]}
                value={tab}
                onChange={(k) => setTab(k as TabKey)}
              />

              {tab === 'invoices' && (
                <DataTable
                  columns={invoiceColumns}
                  rows={activity.data?.invoices ?? []}
                  rowKey={(i) => i.id}
                  isLoading={activity.isLoading}
                  rowTone={(i) => (i.status === 'overdue' ? 'danger' : 'default')}
                  emptyTitle="No invoices for this customer"
                />
              )}
              {tab === 'orders' && (
                <DataTable
                  columns={orderColumns}
                  rows={activity.data?.orders ?? []}
                  rowKey={(o) => o.id}
                  isLoading={activity.isLoading}
                  emptyTitle="No orders for this customer"
                />
              )}
              {tab === 'payments' && (
                <DataTable
                  columns={paymentColumns}
                  rows={activity.data?.payments ?? []}
                  rowKey={(p) => p.id}
                  isLoading={activity.isLoading}
                  emptyTitle="No payments received"
                />
              )}
            </Card>
          </>
        }
        aside={
          <>
            <Card padded={false}>
              <CardHeader title="Credit position" />
              <div className="space-y-3 p-4">
                <div>
                  <p className="text-2xl font-semibold text-primary tabular">
                    <MoneyText value={c.balance} />
                  </p>
                  <p className="text-xs text-muted">Currently owed to us</p>
                </div>

                <div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
                    <div
                      className={cn(
                        'h-full rounded-full',
                        creditPct > 100 ? 'bg-danger' : creditPct > 80 ? 'bg-warning' : 'bg-success',
                      )}
                      style={{ width: `${Math.min(100, creditPct)}%` }}
                    />
                  </div>
                  <p className="mt-1 flex items-center justify-between text-xs">
                    <span className="text-muted">
                      {creditPct.toFixed(0)}% of <MoneyText value={c.creditLimit} muted /> limit
                    </span>
                    {creditPct > 100 && <Badge tone="danger">Over limit</Badge>}
                  </p>
                </div>
              </div>
            </Card>

            <Card padded={false}>
              <CardHeader title="Aging" subtitle="Outstanding by age" />
              <div className="p-4">
                {aging ? (
                  <AgingBars bands={bands} total={aging.total} />
                ) : (
                  <p className="py-4 text-center text-xs text-muted">Nothing outstanding</p>
                )}
              </div>
            </Card>

            <Card>
              <p className="text-2xs font-medium tracking-wide text-muted uppercase">Sales rep</p>
              <p className="mt-1 text-sm text-primary">
                {activity.data?.orders[0]?.salesRep.name ?? 'Not assigned'}
              </p>
              <Link
                to={`/sales/orders?customerId=${c.id}`}
                className="mt-3 block text-xs text-accent-text hover:underline"
              >
                View all orders for this customer
              </Link>
            </Card>

            <HistoryPanel targetId={c.id} />
          </>
        }
      />
    </>
  );
}
