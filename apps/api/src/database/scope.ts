/**
 * The trusted scope a data access operation runs under.
 *
 * Contract section 6.3: every repository method requires an actor context argument, and
 * constructing an unscoped query must not be possible through the public interface of the data
 * layer. This file defines what that context is; `unit-of-work.ts` is what makes it mandatory.
 *
 * WHERE A SCOPE COMES FROM, AND WHERE IT NEVER COMES FROM. A scope is built from the server side
 * session, per contract section 2.5. It is never built from a request body, a query parameter, a
 * path segment or a client supplied header. The type below cannot enforce that on its own, so
 * the rule is stated here and tested at the HTTP boundary when that boundary exists: nothing in
 * this layer accepts a tenant or company identifier as data and then treats it as authority.
 */

/** A real person acting inside one company, resolved from their session. */
export interface ActorScope {
  readonly kind: 'actor';
  readonly tenantId: string;
  readonly companyId: string;
  readonly userId: string;
}

/**
 * The reasons a system scope may exist, as a closed union.
 *
 * Contract section 6.3 requires background and migration access to use "an explicitly named
 * system context, which is greppable and reviewable". A closed union is how that is enforced:
 * adding a reason is a visible change to this type, and every existing use can be found by
 * searching for the literal.
 */
export type SystemScopeReason =
  /** Authentication, which by definition runs before any tenant is known. */
  | 'authentication'
  | 'tenant-provisioning'
  | 'scheduled-maintenance'
  | 'integration-test';

/**
 * Operations that legitimately run outside any one actor's authority.
 *
 * A system scope is NOT an escape hatch from tenant isolation. With no `tenantId` it can reach
 * only the global tables, because row level security denies every tenant-scoped row when the
 * context is empty. Provisioning a tenant is the one case that needs to write tenant-scoped
 * rows, and it must name the tenant it is provisioning, which keeps the reach explicit rather
 * than unlimited.
 */
export interface SystemScope {
  readonly kind: 'system';
  readonly reason: SystemScopeReason;
  /** Present only when the operation must write inside one named tenant. */
  readonly tenantId?: string;
  readonly companyId?: string;
}

export type Scope = ActorScope | SystemScope;

export function actorScope(input: {
  tenantId: string;
  companyId: string;
  userId: string;
}): ActorScope {
  assertUuid(input.tenantId, 'tenantId');
  assertUuid(input.companyId, 'companyId');
  assertUuid(input.userId, 'userId');

  return {
    kind: 'actor',
    tenantId: input.tenantId,
    companyId: input.companyId,
    userId: input.userId,
  };
}

export function systemScope(
  reason: SystemScopeReason,
  within?: { tenantId: string; companyId?: string },
): SystemScope {
  if (within) {
    assertUuid(within.tenantId, 'tenantId');
    if (within.companyId !== undefined) assertUuid(within.companyId, 'companyId');
  }

  return {
    kind: 'system',
    reason,
    ...(within?.tenantId !== undefined ? { tenantId: within.tenantId } : {}),
    ...(within?.companyId !== undefined ? { companyId: within.companyId } : {}),
  };
}

export function isActorScope(scope: Scope): scope is ActorScope {
  return scope.kind === 'actor';
}

/** Who to record as the author of a write. Null for system operations, per the schema. */
export function actingUserId(scope: Scope): string | null {
  return scope.kind === 'actor' ? scope.userId : null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identifiers are validated on the way in, not on the way to the database.
 *
 * These values become transaction local settings, so a malformed one would produce a cast error
 * inside a policy rather than a clear failure at the boundary. Rejecting here also means a
 * caller cannot smuggle anything other than a UUID into the context.
 */
function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Scope ${field} must be a UUID, received ${JSON.stringify(value)}`);
  }
}
