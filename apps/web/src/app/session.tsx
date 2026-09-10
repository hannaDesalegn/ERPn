/**
 * Session and permission context, from the server.
 *
 * This file used to be a role switcher over fixture users. It is now a client for `/me`, and
 * the difference is not cosmetic: nothing below constructs a user, a company, a role or a
 * permission. Every value it exposes arrived in a server response, and when there is no
 * response there is no session rather than a default one.
 *
 * SECURITY REMINDER, unchanged from when this was a mock and more important now that it is not:
 * `can()` decides what to RENDER. It decides nothing about what is ALLOWED. The server re-checks
 * every permission on every request, because anyone can call the API without going through this
 * interface. A user who edits `permissions` in a debugger changes what their own browser draws
 * and nothing about what the server will do for them. That is the intended property, and it is
 * why hiding a control is a usability decision rather than a security one.
 *
 * WHAT IS NOT STORED. No token, no password, nothing in `localStorage` or `sessionStorage`. The
 * session lives in an HttpOnly cookie that script cannot read; the browser attaches it and this
 * code never sees it. There is deliberately no "remember me" and no cached copy of `/me` outside
 * the query cache, which is memory only and dies with the tab.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Permission } from '@/domain';
import { sessionApi, type Me } from '@/services/session.service';

export const SESSION_QUERY_KEY = ['session', 'me'] as const;

/**
 * The three states a session can be in, as a union rather than as flags.
 *
 * Flags would permit `loading && authenticated`, and the branch that handles it would be written
 * once, badly, by whoever hit it first. A union makes the gate exhaustive.
 */
export type SessionState =
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'error'; message: string }
  | { status: 'authenticated'; me: Me };

interface SessionContextValue {
  state: SessionState;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  switchCompany: (companyId: string) => Promise<void>;
  /** Re-reads `/me`. Used after anything that could change what this person may do. */
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: sessionApi.me,
    // Not retried. `/me` answering 401 is already handled as "nobody is signed in", so a
    // failure here is a server or network problem, and retrying it three times only delays the
    // moment the person is told.
    retry: false,
    // Always considered stale. Membership and roles change under a live session, and the server
    // re-derives on every request it serves, so the interface should not be showing a permission
    // set from ten minutes ago.
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const setMe = useCallback(
    (me: Me | null) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, me);
    },
    [queryClient],
  );

  /**
   * Drops every cached query except the session itself.
   *
   * Compared by content rather than by identity, because the key React Query holds is a copy of
   * the array and `!==` against the original is true for it too. That mistake removes the
   * session along with everything else, which reads as an instant sign-out and is very hard to
   * see in a diff.
   */
  const clearDataQueries = useCallback(() => {
    queryClient.removeQueries({
      predicate: (query) => JSON.stringify(query.queryKey) !== JSON.stringify(SESSION_QUERY_KEY),
    });
  }, [queryClient]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
  }, [queryClient]);

  const signIn = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      sessionApi.signIn(email, password),
    onSuccess: async () => {
      // The sign-in response carries nothing, on purpose. Who this is comes from asking.
      await refresh();
    },
  });

  const signOut = useMutation({
    mutationFn: sessionApi.signOut,
    onSuccess: () => {
      // Cleared rather than refetched. The session is gone server side, and asking again would
      // only produce the 401 we already know is coming. Everything else in the cache goes too:
      // it was fetched for a person who is no longer here, and leaving it would let the next
      // sign-in on this machine open onto the previous one's data before any request returned.
      clearDataQueries();
      setMe(null);
    },
  });

  const switchCompany = useMutation({
    mutationFn: sessionApi.switchCompany,
    onSuccess: (me) => {
      // Everything else was loaded under the previous company and belongs to it. Dropped before
      // the new session is set, so no screen can render the new company's header over the old
      // company's rows.
      clearDataQueries();
      // The server returns the refreshed view, so the new company, roles and permissions all
      // come from it. Assembling them here from the identifier that was sent would mean the
      // interface believed a switch the server might have refused.
      setMe(me);
    },
  });

  const state = useMemo<SessionState>(() => {
    if (query.isPending) return { status: 'loading' };
    if (query.isError) {
      return {
        status: 'error',
        message: query.error instanceof Error ? query.error.message : 'Could not reach the server',
      };
    }
    if (!query.data) return { status: 'unauthenticated' };

    return { status: 'authenticated', me: query.data };
  }, [query.isPending, query.isError, query.error, query.data]);

  const value = useMemo<SessionContextValue>(
    () => ({
      state,
      signIn: async (email, password) => {
        await signIn.mutateAsync({ email, password });
      },
      signOut: async () => {
        await signOut.mutateAsync();
      },
      switchCompany: async (companyId) => {
        await switchCompany.mutateAsync(companyId);
      },
      refresh,
    }),
    [state, signIn, signOut, switchCompany, refresh],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The raw state, for the gate that decides which of the three trees to render. */
export function useSessionState(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSessionState must be used inside a SessionProvider');
  return context;
}

export interface AuthenticatedSession {
  user: Me['user'];
  companies: Me['companies'];
  activeCompany: NonNullable<Me['activeCompany']>;
  roles: Me['roles'];
  permissions: ReadonlySet<string>;
  /** True when the server reported this capability in the active company. */
  can: (permission: Permission) => boolean;
  /** True when the server reported at least one of them. */
  canAny: (...permissions: Permission[]) => boolean;
  signOut: () => Promise<void>;
  switchCompany: (companyId: string) => Promise<void>;
}

/**
 * The signed-in session, for screens.
 *
 * Throws when there is none, and that is the point rather than a rough edge. Every screen runs
 * inside a gate that has already established an authenticated session with a company entered, so
 * a screen reaching this without one is a routing mistake. Returning a blank user instead would
 * turn that mistake into a page rendered for nobody, which is exactly the state a "not
 * authenticated" branch is supposed to prevent.
 */
export function useSession(): AuthenticatedSession {
  const { state, signOut, switchCompany } = useSessionState();

  const session = useMemo(() => {
    if (state.status !== 'authenticated' || !state.me.activeCompany) return null;

    const permissions = new Set(state.me.permissions);

    return {
      user: state.me.user,
      companies: state.me.companies,
      activeCompany: state.me.activeCompany,
      roles: state.me.roles,
      permissions,
      can: (permission: Permission) => permissions.has(permission),
      canAny: (...list: Permission[]) => list.some((p) => permissions.has(p)),
      signOut,
      switchCompany,
    } satisfies AuthenticatedSession;
  }, [state, signOut, switchCompany]);

  if (!session) {
    throw new Error(
      'useSession requires an authenticated session inside a company. Render this inside the session gate.',
    );
  }

  return session;
}

/**
 * Conditional render helper.
 *
 * Prefer HIDING an action the user cannot perform over disabling it. A disabled button with no
 * explanation is a dead end; an absent button keeps the interface honest about what this
 * person's job is. Show a disabled control only when the user could plausibly gain the right,
 * for example "needs manager approval", and say so.
 */
export function Can({
  permission,
  any,
  children,
  fallback = null,
}: {
  permission?: Permission;
  any?: Permission[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { can, canAny } = useSession();
  const allowed = permission ? can(permission) : any ? canAny(...any) : true;
  return <>{allowed ? children : fallback}</>;
}
