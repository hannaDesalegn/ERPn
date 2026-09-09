/**
 * Read-models for the dashboard.
 *
 * These are NOT stored entities. They are shapes a reporting endpoint returns.
 * Keeping them in the domain layer (rather than inventing them inside the
 * dashboard component) means the backend has an explicit contract to implement,
 * and the dashboard is not silently computing business figures on the client.
 *
 * WHY THAT MATTERS: if the frontend sums invoice rows to get "outstanding
 * receivables", then two clients with different page sizes report different
 * totals, and nobody can reconcile the dashboard against the ledger. Aggregates
 * are a BACKEND responsibility. The frontend renders them.
 */

import type { ID, ISODate, Money } from './primitives';
import type { LowStockAlert } from './inventory';

/** A single headline figure, with the comparison that gives it meaning. */
export interface Kpi {
  key: string;
  label: string;
  value: Money | number;
  /** What the same measure was in the previous comparable period. */
  previousValue?: Money | number;
  /** Signed percentage change vs previous period. */
  changePercent?: number;
  /** Whether an increase is good news. Rising payables is not a win. */
  higherIsBetter: boolean;
  /** Short explanation shown in a tooltip so the number is self-documenting. */
  help: string;
  /** Where clicking the tile should take the user. */
  href?: string;
}

export interface TrendPoint {
  date: ISODate;
  value: number;
}

export interface TrendSeries {
  label: string;
  points: TrendPoint[];
  currency?: Money['currency'];
}

/** Something a human needs to act on, ranked by urgency. */
export interface ActionItem {
  id: ID;
  kind:
    | 'approval_pending'
    | 'invoice_overdue'
    | 'low_stock'
    | 'unmatched_bill'
    | 'unallocated_payment'
    | 'credit_limit_exceeded';
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  href: string;
  amount?: Money;
  ageDays?: number;
}

/** Cash position across all bank/cash accounts. */
export interface CashPosition {
  accounts: { id: ID; name: string; balance: Money }[];
  total: Money;
}

export interface AgingBand {
  bucket: 'current' | '1_30' | '31_60' | '61_90' | '90_plus';
  label: string;
  amount: Money;
}

export interface DashboardData {
  kpis: Kpi[];
  salesTrend: TrendSeries;
  purchaseTrend: TrendSeries;
  receivablesAging: AgingBand[];
  payablesAging: AgingBand[];
  cash: CashPosition;
  actionItems: ActionItem[];
  lowStock: LowStockAlert[];
}
