/**
 * Administration: users and roles, and the audit log.
 *
 * The users screen doubles as the permission matrix, because "who can do what"
 * is the question, and a list of role names does not answer it. Seeing that the
 * purchasing officer can create an order but not approve one is the point.
 */

import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { api, queryKeys } from '@/services';
import type { AuditEvent, Permission, User } from '@/domain';
import { Badge, Card, CardHeader, Icon, PageHeader, SearchInput, Select, Skeleton, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { ActivityTimeline } from '@/components/domain/documents';
import { ROLES, ROLE_LIST } from '@/lib/permissions';
import { useListParams } from '@/hooks/useListParams';
import { cn, formatDateTime, formatNumber, humanize, initials } from '@/lib/format';

// ===========================================================================
// Users and roles
// ===========================================================================

/**
 * The permission groups shown in the matrix. Only the state-changing verbs are
 * listed, because those are the ones segregation of duties is about. Read
 * access is comparatively uninteresting.
 */
const MATRIX: { label: string; permission: Permission }[] = [
  { label: 'Confirm orders', permission: 'sales:confirm' },
  { label: 'Raise POs', permission: 'purchasing:create' },
  { label: 'Approve POs', permission: 'purchasing:approve' },
  { label: 'Move stock', permission: 'inventory:move' },
  { label: 'Adjust stock', permission: 'inventory:adjust' },
  { label: 'Post invoices', permission: 'invoices:post' },
  { label: 'Register payments', permission: 'payments:register' },
  { label: 'Post to ledger', permission: 'accounting:post' },
  { label: 'Manage users', permission: 'admin:users' },
];

export function UsersPage() {
  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.admin.listUsers });

  const columns: Column<User>[] = [
    {
      key: 'name',
      header: 'User',
      render: (u) => (
        <div className="flex items-center gap-2">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-2xs font-semibold text-accent-text">
            {initials(u.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-primary">{u.name}</span>
            <span className="block truncate text-xs text-muted">{u.email}</span>
          </span>
        </div>
      ),
    },
    { key: 'jobTitle', header: 'Job title', hideBelow: 'md', render: (u) => u.jobTitle },
    {
      key: 'role',
      header: 'Role',
      width: '170px',
      render: (u) => <Badge tone="accent">{ROLES[u.roleKey].name}</Badge>,
    },
    {
      key: 'warehouse',
      header: 'Restricted to',
      hideBelow: 'xl',
      render: (u) =>
        u.warehouseIds?.length ? (
          <span className="text-xs text-secondary">{u.warehouseIds.length} warehouse</span>
        ) : (
          <span className="text-xs text-muted">All sites</span>
        ),
    },
    {
      key: 'lastLogin',
      header: 'Last seen',
      width: '150px',
      numeric: true,
      hideBelow: 'lg',
      render: (u) => <span className="text-secondary">{formatDateTime(u.lastLoginAt)}</span>,
    },
    {
      key: 'active',
      header: '',
      width: '90px',
      render: (u) => (!u.active ? <Badge tone="neutral">Disabled</Badge> : null),
    },
  ];

  return (
    <>
      <PageHeader title="Users and roles" />

      <Card padded={false} className="mb-4">
        <CardHeader title="Users" />
        <DataTable
          columns={columns}
          rows={users.data ?? []}
          rowKey={(u) => u.id}
          isLoading={users.isLoading}
          rowTone={(u) => (u.active ? 'default' : 'muted')}
          emptyTitle="No users"
        />
      </Card>

      <Card padded={false}>
        <CardHeader
          title="Permission matrix"
          subtitle="Which role may perform each controlled action"
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                <th className="sticky left-0 bg-sunken px-3 py-2 text-left">Action</th>
                {ROLE_LIST.map((role) => (
                  <th key={role.key} className="px-3 py-2 text-center font-semibold" title={role.description}>
                    {role.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((row) => (
                <tr key={row.permission} className="border-b border-line">
                  <td className="sticky left-0 bg-surface px-3 py-2 text-primary">{row.label}</td>
                  {ROLE_LIST.map((role) => {
                    const allowed = role.permissions.includes(row.permission);
                    return (
                      <td key={role.key} className="px-3 py-2 text-center">
                        <span
                          className={cn(
                            'inline-grid size-5 place-items-center rounded-full',
                            allowed ? 'bg-success-soft text-success-text' : 'text-muted',
                          )}
                          aria-label={allowed ? 'Allowed' : 'Not allowed'}
                        >
                          {/* Not colour alone: allowed shows a tick, denied is empty. */}
                          {allowed ? <Icon name="check" className="size-3" strokeWidth={2.5} /> : null}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="border-t border-line px-4 py-3 text-xs text-secondary">
          Note that no single role can both raise a purchase order and approve it. That separation is
          a fraud control, not an oversight. These checks govern what the interface shows; the server
          must enforce them again on every request.
        </p>
      </Card>
    </>
  );
}

// ===========================================================================
// Audit log
// ===========================================================================

const ACTIONS = [
  'created',
  'updated',
  'confirmed',
  'approved',
  'posted',
  'paid',
  'shipped',
  'received',
  'cancelled',
  'logged_in',
  'permission_changed',
];

export function AuditLogPage() {
  const list = useListParams({ defaultSortBy: 'occurredAt', filterKeys: ['action', 'actorId', 'docType'] });

  const query = useQuery({
    queryKey: queryKeys.auditEvents(list.params),
    queryFn: () => api.admin.listAuditEvents({ ...list.params, pageSize: 40 }),
    placeholderData: keepPreviousData,
  });

  const users = useQuery({ queryKey: queryKeys.users, queryFn: api.admin.listUsers });

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who changed what, and when" />

      {/*
        Stated plainly rather than implied. The frontend renders audit records;
        it cannot vouch for them. Presenting this as a security feature without
        the caveat would be the dishonest option.
      */}
      <Card className="mb-4">
        <div className="flex items-start gap-2">
          <Icon name="shield" className="mt-0.5 size-4 shrink-0 text-muted" />
          <p className="text-xs text-secondary">
            These records come from the application fixture layer. A trustworthy audit trail requires
            the backend to write each entry inside the same transaction as the change, take the actor
            from the authenticated session, and keep the table append-only.
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search action, user, document"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search audit log"
          />
          <Select
            value={list.filters['action']?.[0] ?? ''}
            onChange={(e) => list.setFilter('action', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by action"
          >
            <option value="">All actions</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {humanize(a)}
              </option>
            ))}
          </Select>
          <Select
            value={list.filters['actorId']?.[0] ?? ''}
            onChange={(e) => list.setFilter('actorId', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by user"
          >
            <option value="">Everyone</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} events
            </span>
          )}
        </Toolbar>

        {query.isLoading ? (
          <div className="space-y-3 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : (
          <ActivityTimeline events={(query.data?.rows ?? []) as AuditEvent[]} />
        )}

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
