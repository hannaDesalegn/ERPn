/**
 * Session and permission context.
 *
 * TODAY this is a role SWITCHER, not authentication. There is no login, no
 * token, and no server. It exists so that every screen is written against
 * `can('sales:confirm')` from day one, and so you can see the product through
 * each employee's eyes while designing it.
 *
 * WHEN REAL AUTH ARRIVES:
 *   - `useSession` keeps its shape
 *   - the provider fetches /me instead of reading local state
 *   - the role switcher becomes a dev-only tool or disappears
 * No screen changes. That is the entire reason for building it now.
 *
 * SECURITY REMINDER, because it is the easiest thing in an ERP to get wrong:
 * `can()` decides what to RENDER. It decides nothing about what is ALLOWED.
 * The server must re-check every permission on every request, because anyone
 * can call the API without going through this UI.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Permission, RoleKey, Session, User } from '@/domain';
import { ROLES, permissionsFor } from '@/lib/permissions';
import { USERS } from '@/mocks/reference';

interface SessionContextValue extends Session {
  /** True when the current role holds the permission. */
  can: (permission: Permission) => boolean;
  /** True when the role holds at least one of the permissions. */
  canAny: (...permissions: Permission[]) => boolean;
  availableUsers: User[];
  switchUser: (userId: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const DEFAULT_USER_ID = 'u-2'; // Operations Manager — sees most of the product.

export function SessionProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string>(() => {
    return localStorage.getItem('erp.demo.userId') ?? DEFAULT_USER_ID;
  });

  const switchUser = useCallback((id: string) => {
    localStorage.setItem('erp.demo.userId', id);
    setUserId(id);
  }, []);

  const value = useMemo<SessionContextValue>(() => {
    const user = USERS.find((u) => u.id === userId) ?? USERS.find((u) => u.id === DEFAULT_USER_ID)!;
    const role = ROLES[user.roleKey as RoleKey];
    const permissions = permissionsFor(user.roleKey);

    return {
      user,
      role,
      permissions,
      can: (permission) => permissions.has(permission),
      canAny: (...list) => list.some((p) => permissions.has(p)),
      availableUsers: USERS.filter((u) => u.active),
      switchUser,
    };
  }, [userId, switchUser]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside a SessionProvider');
  return context;
}

/**
 * Conditional render helper.
 *
 * Prefer HIDING an action the user cannot perform over disabling it. A disabled
 * button with no explanation is a dead end; an absent button keeps the interface
 * honest about what this person's job is. Show a disabled control only when the
 * user could plausibly gain the right (e.g. "needs manager approval"), and say so.
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
