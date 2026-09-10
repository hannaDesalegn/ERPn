/**
 * Route level permission protection.
 *
 * Criterion 23: a user without the permission receives a proper forbidden screen rather than a
 * rendered page. This is that screen, and the wrapper that decides when to show it.
 *
 * WHAT THIS IS AND IS NOT. It is not access control. The permission it checks came from `/me`,
 * which is a report rather than an authority, and a determined user can change it in a debugger
 * and reach the page. What they cannot change is that every request the page makes is refused by
 * the server, which checks the same permission against the database on every call. So this
 * stops an honest warehouse operator from typing a general ledger URL and landing on a screen of
 * errors. It does not stop anyone from anything, and nothing about the system's safety should
 * ever be argued from it.
 *
 * The permission a route requires is written at the route, next to the element it guards, rather
 * than in a table somewhere else. A table would drift from the routes it describes and the drift
 * would be invisible, because a route missing from the table renders exactly as one that is
 * deliberately open.
 */

import type { ReactNode } from 'react';

import type { Permission } from '@/domain';
import { useSession } from './session';

export function Protected({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can } = useSession();

  if (!can(permission)) return <Forbidden permission={permission} />;

  return <>{children}</>;
}

/**
 * What someone sees when they reach a page their role does not cover.
 *
 * It names the company, because the same person may hold the permission in another one and the
 * useful next step is switching rather than asking for a new role. It does not offer to request
 * access, since nothing behind that button exists yet.
 */
function Forbidden({ permission }: { permission: Permission }) {
  const { activeCompany, roles } = useSession();

  return (
    <div className="grid h-full place-items-center p-8">
      <div className="max-w-md space-y-2 text-center">
        <p className="text-sm font-semibold text-primary">You do not have access to this page</p>
        <p className="text-xs text-muted">
          It needs the {permission} permission, which your roles in {activeCompany.name} do not
          include.
        </p>
        {roles.length > 0 && (
          <p className="text-2xs text-muted">
            Your roles here: {roles.map((role) => role.name).join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}
