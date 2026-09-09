/**
 * Suppliers list and detail.
 *
 * The mirror of customers: instead of credit risk, the operative facts are what
 * we owe and how long the supplier takes to deliver. Lead time sits in the list
 * because it is what purchasing uses to decide when to reorder.
 */

import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { AgingBand, Payment, PurchaseOrder, Supplier, SupplierBill } from '@/domain';
import { Card, CardHeader, ErrorState, Field, PageHeader, SearchInput, Tabs, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { DetailGrid, DetailSkeleton, DetailTitle, HistoryPanel } from '@/components/domain/detail';
import { AgingBars } from '@/components/charts/AgingBars';
import { useListParams } from '@/hooks/useListParams';
import { cn, daysUntil, formatDate, formatNumber } from '@/lib/format';

export function SuppliersPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'name', defaultSortDir: 'asc', filterKeys: ['active'] });

  const query = useQuery({
    queryKey: queryKeys.suppliers(list.params),
    queryFn: () => api.parties.listSuppliers(list.params),
    placeholderData: keepPreviousData,
  });

  const columns: Column<Supplier>[] = [
    {
      key: 'code',
      header: 'Code',
      sortable: true,
      width: '110px',
      render: (s) => <span className="text-secondary tabular">{s.code}</span>,
    },
    {
      key: 'name',
      header: 'Supplier',
      sortable: true,
      render: (s) => (
        <>
          <span className="block truncate font-medium text-primary">{s.name}</span>
          <span className="text-xs text-muted">
            {s.address?.city}, {s.address?.country}
          </span>
        </>
      ),
    },
    {
      key: 'terms',
      header: 'Terms',
      width: '110px',
      hideBelow: 'md',
      render: (s) => <span className="text-secondary">{s.paymentTerms.label}</span>,
    },
    {
      /** Days from order to delivery. Drives when a reorder must be raised. */
      key: 'leadTimeDays',
      header: 'Lead time',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '100px',
      hideBelow: 'lg',
      render: (s) => <span className="text-secondary">{s.leadTimeDays} days</span>,
    },
    {
      key: 'balance',
      header: 'We owe',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      render: (s) => <MoneyText value={s.balance} strong />,
    },
  ];

  return (
    <>
      <PageHeader title="Suppliers" />
      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search name, code, city"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search suppliers"
          />
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} suppliers
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(s) => s.id}
          isLoading={query.isLoading}
          onRowClick={(s) => navigate(`/purchasing/suppliers/${s.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No suppliers match"
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

type TabKey = 'bills' | 'orders' | 'payments';

export function SupplierDetailPage() {
  const { id = '' } = useParams();
  const [tab, setTab] = useState<TabKey>('bills');

  const supplier = useQuery({ queryKey: queryKeys.supplier(id), queryFn: () => api.parties.getSupplier(id) });
  const activity = useQuery({
    queryKey: queryKeys.supplierActivity(id),
    queryFn: () => api.parties.getSupplierActivity(id),
  });

  if (supplier.isError) return <ErrorState message={(supplier.error as Error).message} />;
  if (supplier.isLoading || !supplier.data) return <DetailSkeleton />;

  const s = supplier.data;
  const aging = activity.data?.aging;
  const bands: AgingBand[] = aging
    ? [
        { bucket: 'current', label: 'Not yet due', amount: aging.current },
        { bucket: '1_30', label: '1 to 30 days', amount: aging.d1_30 },
        { bucket: '31_60', label: '31 to 60 days', amount: aging.d31_60 },
        { bucket: '61_90', label: '61 to 90 days', amount: aging.d61_90 },
        { bucket: '90_plus', label: '90+ days', amount: aging.d90_plus },
      ]
    : [];

  const billColumns: Column<SupplierBill>[] = [
    {
      key: 'docNumber',
      header: 'Bill',
      width: '140px',
      render: (b) => <span className="font-medium text-accent-text">{b.docNumber}</span>,
    },
    { key: 'ref', header: 'Their ref', hideBelow: 'lg', render: (b) => b.supplierReference },
    { key: 'date', header: 'Dated', width: '105px', numeric: true, render: (b) => formatDate(b.invoiceDate) },
    {
      key: 'due',
      header: 'Due',
      width: '125px',
      numeric: true,
      render: (b) => {
        const days = daysUntil(b.dueDate);
        const late = days < 0 && b.balanceDue.amount > 0;
        return (
          <span className={cn(late && 'text-danger-text')}>
            {formatDate(b.dueDate)}
            {late && <span className="ml-1 text-2xs">({-days}d late)</span>}
          </span>
        );
      },
    },
    {
      key: 'match',
      header: 'Match',
      width: '130px',
      hideBelow: 'xl',
      render: (b) => <StatusBadge status={b.matchStatus} />,
    },
    {
      key: 'balance',
      header: 'Outstanding',
      align: 'right',
      numeric: true,
      width: '115px',
      render: (b) => <MoneyText value={b.balanceDue} strong />,
    },
    { key: 'status', header: 'Status', width: '130px', render: (b) => <StatusBadge status={b.status} /> },
  ];

  const orderColumns: Column<PurchaseOrder>[] = [
    {
      key: 'docNumber',
      header: 'Order',
      width: '130px',
      render: (o) => <span className="font-medium text-accent-text">{o.docNumber}</span>,
    },
    { key: 'date', header: 'Ordered', width: '110px', numeric: true, render: (o) => formatDate(o.orderDate) },
    { key: 'expected', header: 'Expected', width: '110px', numeric: true, hideBelow: 'md', render: (o) => formatDate(o.expectedDate) },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      numeric: true,
      width: '110px',
      render: (o) => <MoneyText value={o.total} />,
    },
    { key: 'status', header: 'Status', width: '150px', render: (o) => <StatusBadge status={o.status} /> },
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
        title={<DetailTitle backTo="/purchasing/suppliers" backLabel="Back to suppliers" docNumber={s.name} />}
        subtitle={`${s.code} · ${s.address?.city}, ${s.address?.country}`}
      />

      <DetailGrid
        main={
          <>
            <Card padded={false}>
              <CardHeader title="Details" />
              <dl className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
                <Field label="Code">{s.code}</Field>
                <Field label="Tax ID">{s.taxId}</Field>
                <Field label="Payment terms">{s.paymentTerms.label}</Field>
                <Field label="Lead time">{s.leadTimeDays} days</Field>
                <Field label="Email">{s.email}</Field>
                <Field label="Phone">{s.phone}</Field>
                <Field label="Address">{s.address?.line1}</Field>
                <Field label="Country">{s.address?.country}</Field>
              </dl>
            </Card>

            <Card padded={false}>
              <Tabs
                tabs={[
                  { key: 'bills', label: 'Bills', count: activity.data?.bills.length },
                  { key: 'orders', label: 'Purchase orders', count: activity.data?.orders.length },
                  { key: 'payments', label: 'Payments', count: activity.data?.payments.length },
                ]}
                value={tab}
                onChange={(k) => setTab(k as TabKey)}
              />
              {tab === 'bills' && (
                <DataTable
                  columns={billColumns}
                  rows={activity.data?.bills ?? []}
                  rowKey={(b) => b.id}
                  isLoading={activity.isLoading}
                  rowTone={(b) => (b.status === 'overdue' ? 'danger' : 'default')}
                  emptyTitle="No bills from this supplier"
                />
              )}
              {tab === 'orders' && (
                <DataTable
                  columns={orderColumns}
                  rows={activity.data?.orders ?? []}
                  rowKey={(o) => o.id}
                  isLoading={activity.isLoading}
                  emptyTitle="No purchase orders"
                />
              )}
              {tab === 'payments' && (
                <DataTable
                  columns={paymentColumns}
                  rows={activity.data?.payments ?? []}
                  rowKey={(p) => p.id}
                  isLoading={activity.isLoading}
                  emptyTitle="No payments made"
                />
              )}
            </Card>
          </>
        }
        aside={
          <>
            <Card padded={false}>
              <CardHeader title="Balance" />
              <div className="p-4">
                <p className="text-2xl font-semibold text-primary tabular">
                  <MoneyText value={s.balance} />
                </p>
                <p className="text-xs text-muted">Currently owed to this supplier</p>
              </div>
            </Card>

            <Card padded={false}>
              <CardHeader title="Aging" subtitle="Outstanding by age" />
              <div className="p-4">
                {aging ? (
                  <AgingBars bands={bands} total={aging.total} emptyLabel="Nothing outstanding" />
                ) : (
                  <p className="py-4 text-center text-xs text-muted">Nothing outstanding</p>
                )}
              </div>
            </Card>

            <Card>
              <p className="text-2xs font-medium tracking-wide text-muted uppercase">Reordering</p>
              <p className="mt-1 text-sm text-secondary">
                Orders placed with this supplier should be raised at least {s.leadTimeDays} days before
                stock is needed.
              </p>
            </Card>

            <HistoryPanel targetId={s.id} />
          </>
        }
      />
    </>
  );
}

export { SuppliersPage as default };
