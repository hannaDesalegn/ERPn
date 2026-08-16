/** Display helpers shared across screens. Pure functions, no React. */

import type { ISODate, ISODateTime, Quantity, Uom } from '@/domain';
import { now } from './clock';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const DATETIME_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Missing values render as an empty cell, not as a dash.
 *
 * A dash is a character the reader has to interpret. An empty cell under a
 * labelled column already means "no value" without asking anything of them.
 * Layout is held by a minimum height on the field, not by filler text.
 */
export function formatDate(value?: ISODate | null): string {
  if (!value) return '';
  return DATE_FMT.format(new Date(value));
}

export function formatDateTime(value?: ISODateTime | null): string {
  if (!value) return '';
  return DATETIME_FMT.format(new Date(value));
}

/** 'just now', 'yesterday', '3 days ago'. Used in activity feeds. */
export function formatRelative(value: ISODateTime, reference: Date = now()): string {
  const then = new Date(value);
  const diffMs = reference.getTime() - then.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(value.slice(0, 10));
}

/** Whole days between a due date and today. Negative means overdue. */
export function daysUntil(dueDate: ISODate, today: Date = now()): number {
  const due = new Date(`${dueDate}T00:00:00Z`);
  const start = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
  );
  return Math.round((due.getTime() - start.getTime()) / 86_400_000);
}

const UOM_LABEL: Record<Uom, string> = {
  unit: 'ea',
  kg: 'kg',
  litre: 'L',
  box: 'box',
  case: 'case',
  metre: 'm',
};

export function formatQuantity(value: Quantity, uom?: Uom): string {
  const n = Number.isInteger(value) ? value.toString() : value.toFixed(2);
  return uom ? `${n} ${UOM_LABEL[uom]}` : n;
}

export function formatPercent(value: number, digits = 1): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** 'partially_delivered' -> 'Partially delivered'. */
export function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}
