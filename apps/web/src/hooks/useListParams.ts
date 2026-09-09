/**
 * List screen state: search, filters, sort, pagination — synced to the URL.
 *
 * WHY THE URL AND NOT useState:
 * A filtered list is something people SHARE. "Here are the overdue invoices for
 * Nordic Build" should be a link a colleague can open. Keeping the state in the
 * query string also makes the back button behave, survives a refresh, and lets
 * the dashboard deep-link into a pre-filtered list. Local state gives up all of
 * that for no benefit.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { ListParams } from '@/services';

export interface UseListParamsOptions {
  defaultSortBy?: string;
  defaultSortDir?: 'asc' | 'desc';
  pageSize?: number;
  /** Filter keys this screen supports; anything else in the URL is ignored. */
  filterKeys?: string[];
}

export function useListParams({
  defaultSortBy,
  defaultSortDir = 'desc',
  pageSize = 25,
  filterKeys = [],
}: UseListParamsOptions = {}) {
  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get('q') ?? '';
  const sortBy = searchParams.get('sort') ?? defaultSortBy;
  const sortDir = (searchParams.get('dir') as 'asc' | 'desc' | null) ?? defaultSortDir;
  const page = Number(searchParams.get('page') ?? '1');

  const filters = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const key of filterKeys) {
      const raw = searchParams.get(key);
      if (raw) result[key] = raw.split(',');
    }
    return result;
    // searchParams identity changes on every navigation, which is the signal we want.
  }, [searchParams, filterKeys]);

  const update = useCallback(
    (patch: Record<string, string | undefined>, resetPage = true) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === '') next.delete(key);
            else next.set(key, value);
          }
          // Changing a filter must return to page 1, or the user lands on an
          // empty page and thinks the filter found nothing.
          if (resetPage && !('page' in patch)) next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const params: ListParams = useMemo(
    () => ({
      search: search || undefined,
      filters,
      sortBy,
      sortDir,
      page,
      pageSize,
    }),
    [search, filters, sortBy, sortDir, page, pageSize],
  );

  return {
    params,
    search,
    filters,
    sortBy,
    sortDir,
    page,
    setSearch: (value: string) => update({ q: value || undefined }),
    setFilter: (key: string, values: string[]) => update({ [key]: values.length ? values.join(',') : undefined }),
    setSort: (key: string, dir: 'asc' | 'desc') => update({ sort: key, dir }, false),
    setPage: (value: number) => update({ page: String(value) }, false),
    clearAll: () => setSearchParams({}, { replace: true }),
    /** True when any filter or search is active — drives the "clear" affordance. */
    isFiltered: Boolean(search) || Object.keys(filters).length > 0,
  };
}
