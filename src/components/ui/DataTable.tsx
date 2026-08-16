/**
 * The table.
 *
 * In an ERP the table IS the product — users spend most of their day in one.
 * So it gets real attention: dense rows, sticky header, sortable columns,
 * right-aligned tabular numerals, keyboard-navigable rows, loading skeletons,
 * and a footer that can carry column totals.
 *
 * Generic over the row type so column definitions stay type-checked against the
 * domain model. If a field is renamed in @/domain, every column referencing it
 * fails to compile — which is the point of having types at all.
 */

import { useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/format';
import { Icon } from './Icon';
import { EmptyState, Skeleton } from './index';

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Cell renderer. Keep it presentational — no data fetching, no business rules. */
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Set when the column can be sorted; value is passed to the server as sortBy. */
  sortable?: boolean;
  width?: string;
  /** Hide below the given breakpoint so narrow screens keep the key columns. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
  /** Numeric columns get tabular figures automatically. */
  numeric?: boolean;
}

const HIDE_CLASS = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
} as const;

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  isLoading?: boolean;
  onRowClick?: (row: T) => void;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (key: string, dir: 'asc' | 'desc') => void;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Rendered as a sticky footer row — used for column totals. */
  footer?: ReactNode;
  /** Visually flags rows needing attention (overdue, blocked, inactive). */
  rowTone?: (row: T) => 'default' | 'danger' | 'muted';
  skeletonRows?: number;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  isLoading = false,
  onRowClick,
  sortBy,
  sortDir = 'desc',
  onSortChange,
  emptyTitle = 'Nothing to show',
  emptyDescription,
  footer,
  rowTone,
  skeletonRows = 8,
}: DataTableProps<T>) {
  const headerCells = useMemo(
    () =>
      columns.map((column) => {
        const isSorted = sortBy === column.key;
        const nextDir: 'asc' | 'desc' = isSorted && sortDir === 'asc' ? 'desc' : 'asc';

        return (
          <th
            key={column.key}
            scope="col"
            style={column.width ? { width: column.width } : undefined}
            aria-sort={isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
            className={cn(
              'border-b border-line bg-sunken px-3 py-2 text-2xs font-semibold tracking-wide text-secondary uppercase',
              column.align === 'right' && 'text-right',
              column.align === 'center' && 'text-center',
              !column.align && 'text-left',
              column.hideBelow && HIDE_CLASS[column.hideBelow],
            )}
          >
            {column.sortable && onSortChange ? (
              <button
                type="button"
                onClick={() => onSortChange(column.key, nextDir)}
                className={cn(
                  'inline-flex items-center gap-1 hover:text-primary',
                  column.align === 'right' && 'flex-row-reverse',
                  isSorted && 'text-primary',
                )}
              >
                {column.header}
                <Icon
                  name={isSorted && sortDir === 'asc' ? 'arrowUp' : 'arrowDown'}
                  className={cn('size-3 transition-opacity', isSorted ? 'opacity-100' : 'opacity-25')}
                />
              </button>
            ) : (
              column.header
            )}
          </th>
        );
      }),
    [columns, sortBy, sortDir, onSortChange],
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10">
          <tr>{headerCells}</tr>
        </thead>

        <tbody>
          {isLoading &&
            Array.from({ length: skeletonRows }).map((_, i) => (
              <tr key={`skeleton-${i}`} className="border-b border-line">
                {columns.map((column) => (
                  <td key={column.key} className={cn('px-3 py-2', column.hideBelow && HIDE_CLASS[column.hideBelow])}>
                    <Skeleton className="h-3.5 w-full max-w-32" />
                  </td>
                ))}
              </tr>
            ))}

          {!isLoading &&
            rows.map((row) => {
              const tone = rowTone?.(row) ?? 'default';
              const interactive = Boolean(onRowClick);
              return (
                <tr
                  key={rowKey(row)}
                  onClick={interactive ? () => onRowClick!(row) : undefined}
                  onKeyDown={
                    interactive
                      ? (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onRowClick!(row);
                          }
                        }
                      : undefined
                  }
                  tabIndex={interactive ? 0 : undefined}
                  role={interactive ? 'button' : undefined}
                  className={cn(
                    'border-b border-line transition-colors',
                    interactive && 'cursor-pointer hover:bg-hover focus-visible:bg-hover',
                    tone === 'danger' && 'bg-danger-soft/35',
                    tone === 'muted' && 'text-muted',
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-3 py-2 align-middle',
                        column.align === 'right' && 'text-right',
                        column.align === 'center' && 'text-center',
                        column.numeric && 'tabular',
                        column.hideBelow && HIDE_CLASS[column.hideBelow],
                      )}
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
        </tbody>

        {footer && !isLoading && rows.length > 0 && (
          <tfoot>
            <tr className="border-t-2 border-line-strong bg-sunken font-medium">{footer}</tr>
          </tfoot>
        )}
      </table>

      {!isLoading && rows.length === 0 && (
        <EmptyState icon="search" title={emptyTitle} description={emptyDescription} />
      )}
    </div>
  );
}

/**
 * Pagination.
 *
 * Shows "showing X–Y of Z" rather than page numbers alone, because a finance
 * user needs to know the size of the set they are looking at.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
      <p className="text-xs text-muted tabular">
        Showing <span className="font-medium text-secondary">{from}</span> to 
        <span className="font-medium text-secondary">{to}</span> of{' '}
        <span className="font-medium text-secondary">{total}</span>
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="rounded border border-line p-1 text-secondary hover:bg-hover disabled:opacity-40"
        >
          <Icon name="chevronLeft" className="size-3.5" />
        </button>
        <span className="px-1.5 text-xs text-muted tabular">
          {page} / {lastPage}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page + 1)}
          disabled={page >= lastPage}
          aria-label="Next page"
          className="rounded border border-line p-1 text-secondary hover:bg-hover disabled:opacity-40"
        >
          <Icon name="chevronRight" className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
