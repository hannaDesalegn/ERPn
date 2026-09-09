/**
 * Dashboard aggregation.
 *
 * WHY THESE METRICS AND NOT OTHERS
 * --------------------------------
 * A dashboard should answer the questions an operations manager actually asks
 * each morning, in priority order:
 *
 *   1. Are we selling?            -> sales today, sales this month vs last
 *   2. Will we get paid?          -> receivables outstanding, overdue
 *   3. Can we pay our bills?      -> cash position, payables due
 *   4. Can we fulfil orders?      -> inventory value, low stock
 *   5. What is blocked on me?     -> approvals, unmatched bills, unallocated cash
 *
 * Every tile below maps to one of those. Metrics that look impressive but drive
 * no decision (total customers, total products, lifetime orders) are excluded
 * deliberately — a number nobody acts on is clutter that hides the numbers
 * people do act on.
 *
 * The `help` text on each KPI ships in the product as a tooltip, so a new
 * employee can learn what the figure means without training.
 */

import type { ActionItem, DashboardData, Kpi } from '@/domain';
import { formatMoney } from '@/lib/money';
import { daysUntil } from '@/lib/format';
import {
  CASH_POSITION,
  CREDIT_EXCEEDED,
  GROSS_MARGIN_THIS_MONTH,
  INVENTORY_VALUE,
  LOW_STOCK,
  OVERDUE_BILLS,
  OVERDUE_INVOICES,
  PAYABLES_BANDS,
  PENDING_APPROVALS,
  PURCHASES_LAST_MONTH,
  PURCHASES_THIS_MONTH,
  PURCHASE_TREND,
  RECEIVABLES_BANDS,
  SALES_LAST_MONTH,
  SALES_THIS_MONTH,
  SALES_TODAY,
  SALES_TREND,
  TOTAL_PAYABLE,
  TOTAL_RECEIVABLE,
  UNALLOCATED_PAYMENTS,
  UNMATCHED_BILLS,
} from '@/mocks/db';
import { REFERENCE_TODAY } from '@/mocks/rng';
import { delay } from './client';

function changePercent(current: number, previous: number): number | undefined {
  if (previous === 0) return undefined;
  return ((current - previous) / previous) * 100;
}

function buildKpis(): Kpi[] {
  return [
    {
      key: 'sales_today',
      label: 'Sales today',
      value: SALES_TODAY,
      higherIsBetter: true,
      help: 'Net value of sales orders confirmed today, excluding tax. Tax is excluded because VAT is collected on behalf of the government and is never our revenue.',
      href: '/sales/orders',
    },
    {
      key: 'sales_month',
      label: 'Sales this month',
      value: SALES_THIS_MONTH,
      previousValue: SALES_LAST_MONTH,
      changePercent: changePercent(SALES_THIS_MONTH.amount, SALES_LAST_MONTH.amount),
      higherIsBetter: true,
      help: 'Confirmed sales month to date, compared with the same measure for the whole of last month. Cancelled and draft orders are excluded, because a draft is not a sale.',
      href: '/sales/orders',
    },
    {
      key: 'gross_margin',
      label: 'Gross margin (MTD)',
      value: GROSS_MARGIN_THIS_MONTH,
      higherIsBetter: true,
      help: 'Sales value minus the cost of the goods sold. Revenue alone can rise while margin falls, so this is the figure that tells you whether the sales were actually worth making.',
      href: '/reports',
    },
    {
      key: 'receivables',
      label: 'Owed to us',
      value: TOTAL_RECEIVABLE,
      higherIsBetter: false,
      help: 'Total unpaid balance on posted customer invoices (accounts receivable). This is money already earned but not yet collected. High receivables mean profit that has not turned into cash.',
      href: '/sales/invoices',
    },
    {
      key: 'payables',
      label: 'We owe',
      value: TOTAL_PAYABLE,
      higherIsBetter: false,
      help: 'Total unpaid balance on posted supplier bills (accounts payable). Compare against cash: if payables due soon exceed available cash, you have a liquidity problem regardless of profitability.',
      href: '/purchasing/bills',
    },
    {
      key: 'cash',
      label: 'Cash & bank',
      value: CASH_POSITION.total,
      higherIsBetter: true,
      help: 'Combined balance of all cash and bank accounts. Profit is an opinion, cash is a fact. A profitable business still fails if it runs out of cash.',
      href: '/accounting/accounts',
    },
    {
      key: 'inventory_value',
      label: 'Inventory value',
      value: INVENTORY_VALUE,
      higherIsBetter: false,
      help: 'Quantity on hand multiplied by unit cost, across all warehouses. This is cash tied up in goods on shelves. Too low and you cannot fulfil orders; too high and capital is stuck.',
      href: '/inventory/stock',
    },
    {
      key: 'purchases_month',
      label: 'Purchases this month',
      value: PURCHASES_THIS_MONTH,
      previousValue: PURCHASES_LAST_MONTH,
      changePercent: changePercent(PURCHASES_THIS_MONTH.amount, PURCHASES_LAST_MONTH.amount),
      higherIsBetter: false,
      help: 'Value of approved purchase orders month to date. Rising purchases without rising sales usually means stock is building up.',
      href: '/purchasing/orders',
    },
  ];
}

function buildActionItems(): ActionItem[] {
  const items: ActionItem[] = [];

  for (const po of PENDING_APPROVALS) {
    items.push({
      id: `approve-${po.id}`,
      kind: 'approval_pending',
      severity: 'warning',
      title: `Approve ${po.docNumber}`,
      detail: `${po.supplier.name} · raised by ${po.requestedBy.name}`,
      href: `/purchasing/orders/${po.id}`,
      amount: po.total,
      ageDays: -daysUntil(po.orderDate, REFERENCE_TODAY),
    });
  }

  for (const invoice of [...OVERDUE_INVOICES].sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 6)) {
    const overdueBy = -daysUntil(invoice.dueDate, REFERENCE_TODAY);
    items.push({
      id: `overdue-${invoice.id}`,
      kind: 'invoice_overdue',
      severity: overdueBy > 60 ? 'critical' : 'warning',
      title: `${invoice.docNumber} overdue by ${overdueBy} days`,
      detail: invoice.party.name,
      href: `/sales/invoices/${invoice.id}`,
      amount: invoice.balanceDue,
      ageDays: overdueBy,
    });
  }

  for (const bill of UNMATCHED_BILLS.slice(0, 4)) {
    items.push({
      id: `unmatched-${bill.id}`,
      kind: 'unmatched_bill',
      severity: 'warning',
      title: `${bill.docNumber} failed three-way match`,
      detail: `${bill.party.name} · ${bill.matchStatus.replace('_', ' ')} against ${bill.purchaseOrderNumbers.join(', ')}`,
      href: `/purchasing/bills/${bill.id}`,
      amount: bill.balanceDue,
    });
  }

  for (const payment of UNALLOCATED_PAYMENTS.slice(0, 4)) {
    items.push({
      id: `unallocated-${payment.id}`,
      kind: 'unallocated_payment',
      severity: 'info',
      title: `Unallocated receipt ${payment.docNumber}`,
      detail: `${payment.party.name} · not yet matched to an invoice`,
      href: `/finance/payments/${payment.id}`,
      amount: payment.unallocatedAmount,
    });
  }

  for (const customer of CREDIT_EXCEEDED.slice(0, 3)) {
    items.push({
      id: `credit-${customer.id}`,
      kind: 'credit_limit_exceeded',
      severity: 'critical',
      title: `${customer.name} is over its credit limit`,
      detail: `Balance ${formatMoney(customer.balance)} against a limit of ${formatMoney(customer.creditLimit)}`,
      href: `/sales/customers/${customer.id}`,
      amount: customer.balance,
    });
  }

  const uncovered = LOW_STOCK.filter((l) => !l.covered);
  if (uncovered.length) {
    items.push({
      id: 'low-stock-summary',
      kind: 'low_stock',
      severity: uncovered.some((l) => l.available <= 0) ? 'critical' : 'warning',
      title: `${uncovered.length} products below reorder point`,
      detail: 'No incoming purchase order covers the shortfall',
      href: '/inventory/stock',
    });
  }

  for (const bill of OVERDUE_BILLS.slice(0, 3)) {
    items.push({
      id: `bill-overdue-${bill.id}`,
      kind: 'invoice_overdue',
      severity: 'warning',
      title: `We are late paying ${bill.docNumber}`,
      detail: bill.party.name,
      href: `/purchasing/bills/${bill.id}`,
      amount: bill.balanceDue,
      ageDays: -daysUntil(bill.dueDate, REFERENCE_TODAY),
    });
  }

  const rank = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.ageDays ?? 0) - (a.ageDays ?? 0));
}

export const dashboardService = {
  async get(): Promise<DashboardData> {
    return delay({
      kpis: buildKpis(),
      salesTrend: { label: 'Sales', points: SALES_TREND, currency: 'USD' },
      purchaseTrend: { label: 'Purchases', points: PURCHASE_TREND, currency: 'USD' },
      receivablesAging: RECEIVABLES_BANDS,
      payablesAging: PAYABLES_BANDS,
      cash: CASH_POSITION,
      actionItems: buildActionItems(),
      lowStock: LOW_STOCK.slice(0, 8),
    });
  },
};
