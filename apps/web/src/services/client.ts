/**
 * The API client seam.
 *
 * EVERY service function in this folder returns a Promise and behaves like a
 * network call, even though the data currently comes from memory. That is the
 * whole point: components already handle loading, empty, and error states, so
 * pointing at a real server changes only the inside of these functions.
 *
 * WHEN THE BACKEND EXISTS
 * -----------------------
 * Replace `delay(...)` + array filtering with `request(...)`. The exported
 * function signatures, the params types, and the Paginated<T> envelope stay
 * identical, so no component changes. That is the payoff for not calling fetch
 * directly from a component.
 *
 * FUTURE INTEGRATION CONCERN (Odoo / ERPNext / custom):
 * Odoo speaks JSON-RPC over `/web/dataset/call_kw` with domain filters shaped
 * like [['state','=','sale']], not REST query strings. ERPNext uses
 * `/api/resource/<Doctype>`. Neither matches this shape exactly, and that is
 * fine — the adapter lives HERE, in one folder, and translates. Nothing in the
 * UI needs to know which backend won.
 */

const ARTIFICIAL_LATENCY_MS = 180;

/** Simulates network latency so loading states are actually exercised in dev. */
export function delay<T>(value: T, ms: number = ARTIFICIAL_LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Thrown for a not-found id so screens can render a real 404 state. */
export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`);
    this.name = 'NotFoundError';
  }
}

/**
 * A response the server refused.
 *
 * The status is carried rather than folded into a message, because the two the caller has to
 * tell apart are 401 and 403 and they mean different things. 401 is "no live session", which the
 * session provider answers by showing the sign-in screen. 403 is "signed in and not allowed",
 * which is a real answer about this person and must not log them out.
 */
export class ApiError extends Error {
  // Declared and assigned rather than as a constructor parameter property, because this
  // workspace compiles with erasableSyntaxOnly and that shape emits runtime code.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// List query contract
// ---------------------------------------------------------------------------

export interface ListParams {
  /** Free-text search. The backend decides which fields it covers. */
  search?: string;
  /** Field -> allowed values. Empty array or undefined means "no filter". */
  filters?: Record<string, string[] | undefined>;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface Paginated<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Aggregates over the WHOLE filtered set, not just this page.
   *
   * This matters: a user filtering to "overdue invoices" wants the total value
   * of all of them, not of the 25 rows currently visible. Computing it on the
   * client from `rows` would silently give the wrong answer, which is precisely
   * the class of bug that destroys trust in a finance screen.
   */
  totals?: Record<string, number>;
}

/**
 * Generic in-memory list processing: search, filter, sort, paginate.
 * A stand-in for what SQL will do server-side.
 */
export function queryList<T>(
  source: T[],
  params: ListParams,
  config: {
    searchFields: (row: T) => (string | undefined)[];
    filterAccessors?: Record<string, (row: T) => string | undefined>;
    sortAccessors?: Record<string, (row: T) => string | number>;
    defaultSort?: { by: string; dir: 'asc' | 'desc' };
  },
): Paginated<T> {
  let rows = [...source];

  const term = params.search?.trim().toLowerCase();
  if (term) {
    rows = rows.filter((row) =>
      config.searchFields(row).some((field) => field?.toLowerCase().includes(term)),
    );
  }

  if (params.filters && config.filterAccessors) {
    for (const [key, allowed] of Object.entries(params.filters)) {
      if (!allowed || allowed.length === 0) continue;
      const accessor = config.filterAccessors[key];
      if (!accessor) continue;
      rows = rows.filter((row) => {
        const value = accessor(row);
        return value !== undefined && allowed.includes(value);
      });
    }
  }

  const sortBy = params.sortBy ?? config.defaultSort?.by;
  const sortDir = params.sortDir ?? config.defaultSort?.dir ?? 'desc';
  const sortAccessor = sortBy ? config.sortAccessors?.[sortBy] : undefined;
  if (sortAccessor) {
    rows.sort((a, b) => {
      const av = sortAccessor(a);
      const bv = sortAccessor(b);
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  const total = rows.length;
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 25;
  const start = (page - 1) * pageSize;

  return { rows: rows.slice(start, start + pageSize), total, page, pageSize };
}

/**
 * The real transport.
 *
 * `credentials: 'include'` is the whole authentication story on this side. The session is an
 * HttpOnly cookie the browser attaches and script cannot read, so there is no token to hold, no
 * header to set, and nothing to put in storage. Anything here that looked like reading a token
 * would mean the cookie had stopped being HttpOnly.
 */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = import.meta.env['VITE_API_URL'] ?? '/api';
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Request failed: ${response.status} ${response.statusText}`);
  }

  // 204 is a success with no body, which sign in and sign out both return. Asking for JSON
  // there throws, and the throw would surface as a failed login after a successful one.
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return undefined as T;
  }

  return (await response.json()) as T;
}
