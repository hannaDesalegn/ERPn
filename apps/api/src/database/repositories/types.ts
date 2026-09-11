/**
 * The public repository surface.
 *
 * These are interfaces only. The implementations are not exported, and there is no exported
 * constructor, factory or raw database handle anywhere in this layer. The only way to obtain a
 * repository is to be handed one inside a `UnitOfWork` callback, which has already opened a
 * transaction and set the tenant context. Contract section 6.3: constructing an unscoped query
 * must not be possible through the public interface of the data layer.
 *
 * Read every signature below with that in mind. No method takes a `tenantId` or `companyId`
 * argument, because the scope is not the caller's to supply. Passing one would reintroduce
 * exactly the vulnerability this layer exists to prevent: a caller who reads an identifier out
 * of a request body and hands it in as authority.
 */

export interface CompanyRecord {
  id: string;
  tenantId: string;
  name: string;
  legalName: string | null;
  baseCurrency: string;
  /**
   * The company standard tax rate, per section 2.9 as amended 2026-09-11.
   *
   * The authority a document line's rate is resolved from, not the rate itself: section 3.4
   * has the line snapshot what applied when it was raised, so changing this never alters a
   * posted document. A string for the reason section 4.3 gives about doubles.
   */
  standardTaxRatePercent: string;
  status: string;
  version: number;
}

export interface MembershipRecord {
  id: string;
  tenantId: string;
  companyId: string;
  userId: string;
  status: string;
  version: number;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  status: string;
  externalSubjectId: string | null;
  version: number;
}

export interface AuditEventInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  changes?: unknown;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The actor's roles as they were at the time, per contract section 7.3. */
  actorRoles?: string[];
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  tenantId: string | null;
  companyId: string | null;
  actorUserId: string | null;
  occurredAt: Date;
}

/**
 * Tenant scoped. Every read is confined to the acting tenant, and every write stamps the
 * tenant from the scope rather than from the payload.
 *
 * Note there is no `list all companies`. Reads return what the tenant may see, which is what
 * makes cross-tenant enumeration impossible rather than merely discouraged.
 */
export interface CompanyRepository {
  findById(id: string): Promise<CompanyRecord | null>;
  listForTenant(): Promise<CompanyRecord[]>;
  /**
   * The named companies, still confined to the acting tenant.
   *
   * Used to put names on the companies a principal already proved membership of. The
   * identifiers come from that person's own membership rows, never from a request, and the
   * tenant predicate still applies, so passing a foreign identifier returns nothing rather
   * than someone else's company.
   */
  listByIds(ids: string[]): Promise<CompanyRecord[]>;
  create(input: { id: string; name: string; legalName?: string | null; baseCurrency: string }): Promise<CompanyRecord>;
  /**
   * Optimistic locking per contract section 10.1. The caller supplies the version it read; a
   * mismatch is a conflict rather than a silent overwrite.
   */
  rename(input: { id: string; name: string; expectedVersion: number }): Promise<CompanyRecord>;
}

/** Company partitioned: reads and writes are confined to the acting company as well. */
export interface MembershipRepository {
  findById(id: string): Promise<MembershipRecord | null>;
  listForCompany(): Promise<MembershipRecord[]>;
  /** Across the tenant, which is what company switching needs. Still never across tenants. */
  listCompanyIdsForUser(userId: string): Promise<string[]>;
  /**
   * The acting user's own membership in the acting company, or null.
   *
   * Takes no user id, because the user is the one in the scope. This is the check that makes a
   * company context trustworthy: it is re-run inside the transaction that acts on the company,
   * so a membership revoked a moment ago cannot be used by a request already in flight.
   */
  findOwnForActiveCompany(): Promise<MembershipRecord | null>;
  /**
   * Every active membership the acting principal holds, across tenants.
   *
   * Available under a principal scope alone, and it takes no user id for the same reason as
   * above: the subject is the scope, not an argument a caller chooses. Cross-tenant by
   * necessity, because a person may work for two of our customers, per section 2.6, and asking
   * inside one tenant cannot discover the other.
   */
  listOwn(): Promise<MembershipRecord[]>;
  create(input: { id: string; userId: string }): Promise<MembershipRecord>;
}

/**
 * Global, per contract section 4.6. Users are not tenant scoped, and pretending otherwise
 * would force a user row per tenant, which section 2.6 rejected.
 *
 * Section 4.6 also says absence of a tenant column is not absence of authorization: this
 * interface offers lookup by identity, never enumeration.
 */
export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  /**
   * The stored password hash, fetched narrowly.
   *
   * Deliberately not a field on `UserRecord`. A hash on the ordinary record would travel
   * everywhere a user does and eventually reach a response body or a log line. Only the
   * authentication path needs it, so only the authentication path can ask.
   */
  findPasswordHash(userId: string): Promise<string | null>;
  create(input: {
    id: string;
    email: string;
    name: string;
    passwordHash?: string | null;
    externalSubjectId?: string | null;
  }): Promise<UserRecord>;
}

/**
 * Append only, and the interface says so by having nowhere to put an update.
 *
 * Contract section 7.1 revokes `UPDATE` and `DELETE` from the application database role, so a
 * tampering attempt fails at the database even if code tried. This interface removes the
 * temptation one layer earlier: there is no method to call.
 */
export interface AuditRepository {
  append(event: AuditEventInput): Promise<AuditEventRecord>;
  listForEntity(entityType: string, entityId: string): Promise<AuditEventRecord[]>;
  /**
   * The most recent events in the acting company, newest first.
   *
   * Company scoped, not merely tenant scoped. The select policy on this table compares the
   * tenant alone, because a platform level row has no company, so filtering by company is the
   * repository's job and a missed predicate here would show one company another's trail inside
   * the same tenant. Section 2.10 lists that among the things that must never happen.
   */
  listForCompany(limit: number): Promise<AuditEventRecord[]>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  activeCompanyId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

/**
 * Global, per contract section 4.6. A session belongs to a global user and carries the active
 * company as state rather than as scope.
 *
 * NOTE WHAT IS ABSENT. There is no method that returns a token, and no field that holds one.
 * The raw token exists only in the moment it is issued and in the cookie afterwards; the
 * database holds a SHA-256 hash and this interface never speaks in anything else.
 */
export interface SessionRepository {
  /** Looks a session up by the hash of a presented token. Never by the token itself. */
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  create(input: {
    id: string;
    userId: string;
    tokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<SessionRecord>;
  /** Extends the idle window on use. Never extends the absolute lifetime. */
  touch(input: { id: string; idleExpiresAt: Date }): Promise<void>;
  /**
   * Records the company this session is now working in.
   *
   * Takes no company identifier. It writes the company the transaction is already scoped to,
   * which means a session can only ever be pointed at a company the caller is already acting
   * inside, with row level security enforcing that context on every other statement in the same
   * transaction. Accepting the company as an argument was the first shape written here, and the
   * rule that no repository method takes a tenant or company is what rejected it: an argument
   * would let a verified membership in one company be followed by a write naming another.
   *
   * Requires an actor scope for that reason.
   */
  setActiveCompany(input: { id: string }): Promise<void>;
  /** Server side revocation. Contract section 5.3. */
  revoke(id: string): Promise<void>;
  /** Revokes every live session for a user, for password change and dismissal. */
  revokeAllForUser(userId: string): Promise<number>;
}

/** What is being counted. Contract section 5.2 requires both per address and per account. */
export type AuthThrottleScopeKind = 'address' | 'account';

export interface AuthThrottleStatus {
  failureCount: number;
  /** Null when not locked. A time in the future means locked until then. */
  lockedUntil: Date | null;
}

/** Deployment level, per contract section 5.3. Never per company at authentication time. */
export interface AuthThrottlePolicy {
  maxAttempts: number;
  windowMinutes: number;
  lockoutMinutes: number;
}

/**
 * Login throttling state. Global, per contract section 4.6 as amended 2026-09-10.
 *
 * Global by necessity rather than convenience: authentication precedes tenant resolution, and
 * an attempt against an address matching no account has no user and no tenant to attribute it
 * to. That attempt is exactly what a per-address limit exists to catch.
 */
export interface AuthThrottleRepository {
  status(kind: AuthThrottleScopeKind, key: string): Promise<AuthThrottleStatus>;
  /**
   * Records one failure and locks if the limit is reached, in a single atomic statement.
   *
   * Atomic matters here more than it looks. A read, then a decision, then a write would let
   * concurrent attempts each read the same count and each conclude they were under the limit,
   * which is precisely the bypass a limiter exists to prevent.
   */
  recordFailure(
    kind: AuthThrottleScopeKind,
    key: string,
    policy: AuthThrottlePolicy,
  ): Promise<AuthThrottleStatus>;
  /**
   * Clears the counter after a successful authentication.
   *
   * Refuses while a lock is in force, so a correct password part way through a lockout cannot
   * end it early. Earlier typos are forgiven; an active lock is not.
   */
  clearOnSuccess(kind: AuthThrottleScopeKind, key: string): Promise<void>;
}
export interface RoleRecord {
  id: string;
  key: string;
  name: string;
  description: string | null;
}

/**
 * Company partitioned, like the roles themselves.
 *
 * Section 2.7: roles are per company, so the same person can be an approver in one company and
 * a viewer in another. This interface cannot express "roles across companies", which is the
 * point rather than a limitation.
 *
 * WRITES VALIDATE AGAINST THE CATALOGUE. Section 2.7 requires a permission absent from the
 * catalogue to be rejected on write. The check lives in the implementation rather than only in
 * a service, because this is the last gate before the row exists and a check one layer up is a
 * check some future caller can go around.
 */
export interface RoleRepository {
  listForMembership(membershipId: string): Promise<RoleRecord[]>;
  /**
   * The distinct permissions every role of one membership grants, unioned.
   *
   * The union is computed in the query rather than by loading roles and merging in memory, so
   * the scope predicate applies to the permission rows themselves and not only to the roles
   * that led to them.
   */
  listPermissionsForMembership(membershipId: string): Promise<string[]>;
  /** Every role defined in the acting company. Never another company's. */
  listForCompany(): Promise<RoleRecord[]>;
  /** What one role grants, used by the escalation check in section 6.6. */
  listPermissionsForRole(roleId: string): Promise<string[]>;
  create(input: {
    id: string;
    key: string;
    name: string;
    description?: string | null;
  }): Promise<RoleRecord>;
  /**
   * Grants capabilities to a role.
   *
   * Rejects any string absent from the catalogue, per section 2.7. Idempotent: granting what is
   * already granted changes nothing, because the pair is the primary key.
   */
  grantPermissions(input: { roleId: string; permissions: readonly string[] }): Promise<void>;
  /** Revokes one capability from a role. The association row is deleted, never soft deleted. */
  revokePermission(input: { roleId: string; permission: string }): Promise<void>;
  assignToMembership(input: { membershipId: string; roleId: string }): Promise<void>;
  removeFromMembership(input: { membershipId: string; roleId: string }): Promise<void>;
  /**
   * Every distinct permission stored anywhere in the acting company.
   *
   * Used by the startup integrity check in section 2.7, which verifies that nothing stored
   * grants a capability the current release no longer defines.
   */
  listStoredPermissions(): Promise<string[]>;
}

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
}

/**
 * The tenant list. Global, and the boundary itself, per section 4.6.
 *
 * Enumeration is offered here and nowhere else, and only to a system scope. Section 2.10
 * forbids any user-facing surface from disclosing that another tenant exists, so nothing that
 * serves a request may reach this. It exists for operations that legitimately span the
 * deployment, such as the startup integrity check in section 2.7.
 */
export interface TenantRepository {
  listAll(): Promise<TenantRecord[]>;
}

/**
 * Master data: the records documents point at.
 *
 * Company scoped, all of them. Section 2.2 describes companies that may share a product
 * catalogue and settles it with a `[FUT]`: shared master data between companies inside one
 * tenant is recorded and not built until asked.
 *
 * ARCHIVED, NEVER DELETED. Section 4.5, and the grants enforce it: the application role holds no
 * `DELETE` on any of these tables. A customer with orders against it must not be removable, and
 * the status column is what replaces removal.
 */
export interface CustomerRecord {
  id: string;
  tenantId: string;
  companyId: string;
  /** The code humans use. Unique within the company that owns the record, never globally. */
  code: string;
  name: string;
  status: string;
  version: number;
}

export interface WarehouseRecord {
  id: string;
  tenantId: string;
  companyId: string;
  code: string;
  name: string;
  status: string;
  /** The default source for sales and destination for purchases. At most one per company. */
  isDefault: boolean;
  /** Section 8.5: negative stock is a policy per warehouse, defaulting to deny. */
  allowNegativeStock: boolean;
  version: number;
}

export interface NewCustomer {
  id: string;
  code: string;
  name: string;
}

export interface NewWarehouse {
  id: string;
  code: string;
  name: string;
  isDefault?: boolean;
  allowNegativeStock?: boolean;
}

/**
 * Archiving a master data record.
 *
 * The version the caller read, per the optimistic locking in section 10.1. A stale value is a
 * conflict rather than a silent overwrite, which is the same shape `CompanyRepository.rename`
 * established in slice 1.
 */
export interface ArchiveRequest {
  id: string;
  expectedVersion: number;
}

export interface CustomerRepository {
  findById(id: string): Promise<CustomerRecord | null>;
  findByCode(code: string): Promise<CustomerRecord | null>;
  listForCompany(): Promise<CustomerRecord[]>;
  create(input: NewCustomer): Promise<CustomerRecord>;
  /** Section 4.5. There is deliberately no delete, and the grant would refuse one anyway. */
  archive(input: ArchiveRequest): Promise<CustomerRecord>;
}

export interface WarehouseRepository {
  findById(id: string): Promise<WarehouseRecord | null>;
  findByCode(code: string): Promise<WarehouseRecord | null>;
  /** The company's default, which is what a sales order uses when none is chosen. */
  findDefault(): Promise<WarehouseRecord | null>;
  listForCompany(): Promise<WarehouseRecord[]>;
  create(input: NewWarehouse): Promise<WarehouseRecord>;
  archive(input: ArchiveRequest): Promise<WarehouseRecord>;
}

/**
 * The catalogue.
 *
 * Note the absence, which section 8.1 calls the single easiest thing for a future contributor to
 * undo under deadline pressure: there is no quantity. Stock is an append only ledger of
 * movements, not an attribute of a product.
 *
 * `salesPrice` is a string for the reason section 4.3 gives about doubles, and it is the master
 * data section 3.3 requires the server to recompute from rather than trusting a price a form
 * sent back.
 */
export interface ProductRecord {
  id: string;
  tenantId: string;
  companyId: string;
  /** The code humans use. Unique within the company, never globally. */
  sku: string;
  name: string;
  /** Only a stockable product participates in inventory. */
  type: string;
  /** Section 8.4: the canonical unit the stock ledger is always recorded in. */
  stockingUom: string;
  salesPrice: string;
  salesPriceCurrency: string;
  status: string;
  version: number;
}

/**
 * A new product.
 *
 * `stockingUom` has no default, deliberately. Section 8.4 says a missing one makes every
 * quantity in history ambiguous, and a default here would be this layer choosing a unit for a
 * business it knows nothing about.
 */
export interface NewProduct {
  id: string;
  sku: string;
  name: string;
  stockingUom: string;
  salesPriceCurrency: string;
  type?: string;
  salesPrice?: string;
}

export interface ProductRepository {
  findById(id: string): Promise<ProductRecord | null>;
  findBySku(sku: string): Promise<ProductRecord | null>;
  listForCompany(): Promise<ProductRecord[]>;
  create(input: NewProduct): Promise<ProductRecord>;
  archive(input: ArchiveRequest): Promise<ProductRecord>;
}

/**
 * Sales documents. Company partitioned, like everything a company owns.
 *
 * DECIMALS CROSS THIS BOUNDARY AS STRINGS. Section 4.3 stores money as exact `NUMERIC` and sends
 * it over the wire as a decimal string, because a JavaScript number is an IEEE-754 double and
 * loses precision silently. Handing back a `number` here would put that loss one layer below
 * everything that cares about it, which is the worst place for it to happen. The caller parses
 * with a decimal type at the point it does arithmetic.
 */
export interface SalesOrderRecord {
  id: string;
  tenantId: string;
  companyId: string;
  /** Null while the order is a draft. Allocated at confirmation, per section 12.2. */
  docNumber: string | null;
  status: string;
  /**
   * Master data this order points at.
   *
   * No foreign key backs these yet, because the tables do not exist. Section 4.1 requires an
   * actual foreign key for every foreign key relationship, so this is a recorded gap rather than
   * a design: the constraint is added by the migration that creates those tables.
   */
  customerId: string;
  warehouseId: string;
  salesRepUserId: string | null;
  orderDate: string;
  expectedDeliveryDate: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  version: number;
}

export interface SalesOrderLineRecord {
  id: string;
  tenantId: string;
  companyId: string;
  salesOrderId: string;
  lineNumber: number;
  productId: string;
  productSku: string;
  productName: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  taxRatePercent: string;
  currency: string;
  lineSubtotal: string;
  lineTax: string;
  lineTotal: string;
  deliveredQuantity: string;
  invoicedQuantity: string;
  version: number;
}

export interface DocumentNumberSequenceRecord {
  id: string;
  tenantId: string;
  companyId: string;
  docType: string;
  prefix: string;
  gapless: boolean;
  /** The counter. A `bigint`, because a number would silently round past 2^53. */
  nextValue: bigint;
  version: number;
}

/**
 * A new order, which is always a draft.
 *
 * Not a rule this interface invents: the table refuses any other status without a document
 * number, and numbers are allocated by the confirming transaction under section 12.2. There is
 * nothing else an order can be created as.
 *
 * No status, no document number and no totals. Totals are computed from the lines by whatever
 * calculates them, which is not the data layer.
 */
export interface NewSalesOrder {
  id: string;
  customerId: string;
  warehouseId: string;
  salesRepUserId?: string | null;
  orderDate: string;
  expectedDeliveryDate?: string | null;
  currency: string;
}

/**
 * A new line.
 *
 * The currency is supplied rather than read from the order, and the database refuses a mismatch
 * through the composite key. Deriving it here would be a query per line to re-establish
 * something the schema already guarantees.
 *
 * The money fields are the caller's arithmetic. This layer stores what it is given.
 */
export interface NewSalesOrderLine {
  id: string;
  salesOrderId: string;
  lineNumber: number;
  productId: string;
  productSku: string;
  productName: string;
  quantity: string;
  unitPrice: string;
  currency: string;
  discountPercent?: string;
  taxRatePercent?: string;
  lineSubtotal?: string;
  lineTax?: string;
  lineTotal?: string;
}

export interface NewDocumentNumberSequence {
  id: string;
  docType: string;
  prefix?: string;
  gapless?: boolean;
}

/**
 * Sales orders, confined to the acting company.
 *
 * READS AND WRITES ONLY. There is no confirm, no number allocation, no total recalculation and
 * no state transition here. Section 12.2 makes confirmation one transaction doing six things,
 * and five of them are not data access.
 */
export interface SalesOrderRepository {
  findById(id: string): Promise<SalesOrderRecord | null>;
  listForCompany(): Promise<SalesOrderRecord[]>;
  create(input: NewSalesOrder): Promise<SalesOrderRecord>;
  /**
   * Writes the document totals, which are a projection of the lines.
   *
   * Separate from `create` because a header exists before its lines can reference it. Valid
   * only inside the transaction that wrote or changed those lines, and it takes no expected
   * version for that reason: there is no concurrent writer to lose an update to, because the
   * rows it is summing are not visible to anyone else yet.
   *
   * The optimistic locking that section 10.1 requires for editing an existing draft arrives
   * with the increment that edits one. A caller reaching for this to change a saved order is
   * using the wrong method.
   */
  setTotals(input: SalesOrderTotals): Promise<SalesOrderRecord>;
}

export interface SalesOrderTotals {
  id: string;
  subtotal: string;
  taxTotal: string;
  total: string;
}

export interface SalesOrderLineRepository {
  listForOrder(salesOrderId: string): Promise<SalesOrderLineRecord[]>;
  create(input: NewSalesOrderLine): Promise<SalesOrderLineRecord>;
  /**
   * Removes a line.
   *
   * Whether the order is still a draft is a state machine question under section 12.2 and is
   * not asked here. The grant exists because editing a draft removes lines.
   */
  remove(id: string): Promise<void>;
}

/** A number taken from a sequence, and the sequence it came from. */
export interface AllocatedDocumentNumber {
  docType: string;
  /** The counter value consumed. A `bigint`, because a number would round past 2^53. */
  value: bigint;
  /** What goes on the document: the sequence prefix and the padded value. */
  formatted: string;
}

/**
 * Document number sequences, per section 10.4.
 *
 * ALLOCATION IS WHY THIS TABLE IS A TABLE. Section 10.4 rules that a gapless sequence forces a
 * counter row locked inside the posting transaction rather than a database sequence, accepting
 * the serialisation cost, because a sequence leaves gaps when a transaction rolls back and many
 * jurisdictions forbid that on an invoice.
 *
 * THERE IS NO WAY TO ALLOCATE OUTSIDE A TRANSACTION. A repository is only ever handed to a
 * callback that `UnitOfWork` has already wrapped in one, so every allocation is inside the
 * caller's transaction by construction and is undone with it. That is the property that makes
 * the sequence gapless, and it is structural rather than remembered.
 */
export interface DocumentNumberSequenceRepository {
  findForDocType(docType: string): Promise<DocumentNumberSequenceRecord | null>;
  listForCompany(): Promise<DocumentNumberSequenceRecord[]>;
  create(input: NewDocumentNumberSequence): Promise<DocumentNumberSequenceRecord>;
  /**
   * Takes the next number for a document type, locking the counter row.
   *
   * Valid only as part of the transaction that writes the document the number goes on. Called
   * on its own it still commits, and the number is then spent on nothing, which is the one way
   * this mechanism can leave a gap. Nothing in the codebase calls it that way, and the sales
   * path reaches it through `allocateSalesOrderNumber`, which takes a transaction's
   * repositories as its argument and so cannot be invoked without one.
   *
   * Throws `DocumentNumberSequenceMissingError` when the company has no sequence configured
   * for the type. Creating one here would let a misspelled document type start a second counter
   * that looks like it has been working since the beginning.
   */
  allocate(docType: string): Promise<AllocatedDocumentNumber>;
}


// ---------------------------------------------------------------------------------------
// Stock.
// ---------------------------------------------------------------------------------------

export interface StockMovementRecord {
  id: string;
  tenantId: string;
  companyId: string;
  productId: string;
  warehouseId: string;
  /** Signed. Positive increased stock, negative decreased it. In the stocking unit, per 8.4. */
  quantity: string;
  reason: string;
  /** The document that caused it. Section 8.1 allows no movement without one. */
  sourceDocType: string;
  sourceDocId: string;
  occurredAt: Date;
}

export interface StockBalanceRecord {
  id: string;
  tenantId: string;
  companyId: string;
  productId: string;
  warehouseId: string;
  /** What every movement for this key sums to. Section 8.2's maintained aggregate. */
  onHand: string;
  version: number;
}

/**
 * A movement to record.
 *
 * No tenant or company: both come from the scope, so this cannot name another company's stock.
 * No balance: the balance is what recording this does, never something a caller states.
 */
export interface NewStockMovement {
  id: string;
  productId: string;
  warehouseId: string;
  quantity: string;
  reason: string;
  sourceDocType: string;
  sourceDocId: string;
  /** Defaults to now. A receipt backdated to yesterday's delivery note is ordinary. */
  occurredAt?: Date;
}

/** Both rows the write produced, so a caller sees the position rather than assuming it. */
export interface RecordedMovement {
  movement: StockMovementRecord;
  balance: StockBalanceRecord;
}

/**
 * The stock ledger of section 8.1 and the balance of section 8.2.
 *
 * There is no method that writes one without the other. Section 8.2 requires them maintained in
 * one transaction, and offering an independent balance write would make the state they exist to
 * prevent reachable through the interface.
 *
 * There is no update and no delete. The ledger is append only, and the application role holds no
 * grant for either, so a correction is a compensating movement rather than an edit.
 */
export interface StockLedgerRepository {
  balanceFor(productId: string, warehouseId: string): Promise<StockBalanceRecord | null>;
  movementsFor(productId: string, warehouseId: string): Promise<StockMovementRecord[]>;
  /** Writes the movement and moves its balance, under the row lock section 10.2 requires. */
  record(input: NewStockMovement): Promise<RecordedMovement>;
}

/** What an actor scoped unit of work hands to its callback. */
export interface ScopedRepositories {
  readonly companies: CompanyRepository;
  readonly customers: CustomerRepository;
  readonly products: ProductRepository;
  readonly warehouses: WarehouseRepository;
  readonly salesOrders: SalesOrderRepository;
  readonly salesOrderLines: SalesOrderLineRepository;
  readonly documentNumberSequences: DocumentNumberSequenceRepository;
  readonly stockLedger: StockLedgerRepository;
  readonly sessions: SessionRepository;
  readonly memberships: MembershipRepository;
  readonly roles: RoleRepository;
  readonly users: UserRepository;
  readonly audit: AuditRepository;
  readonly authThrottle: AuthThrottleRepository;
}

/**
 * What a principal scoped unit of work hands to its callback.
 *
 * The narrowest set. No companies, no roles, no throttle: each of those needs a tenant or a
 * company that a principal scope by definition does not have, and offering a method that can
 * only throw is worse than not offering it.
 *
 * `memberships` here is the discovery read and nothing else. Its other methods require a tenant
 * and refuse without one.
 */
export interface PrincipalRepositories {
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly memberships: MembershipRepository;
  readonly audit: AuditRepository;
}

/**
 * What a system scoped unit of work hands to its callback.
 *
 * Deliberately narrower. Without a tenant in the scope, row level security denies every
 * tenant-scoped row, so offering those repositories would be offering methods that return
 * nothing. Provisioning names its tenant and gets the full set.
 */
export interface SystemRepositories {
  readonly tenants: TenantRepository;
  readonly customers: CustomerRepository;
  readonly products: ProductRepository;
  readonly warehouses: WarehouseRepository;
  readonly salesOrders: SalesOrderRepository;
  readonly salesOrderLines: SalesOrderLineRepository;
  readonly documentNumberSequences: DocumentNumberSequenceRepository;
  readonly stockLedger: StockLedgerRepository;
  readonly users: UserRepository;
  readonly sessions: SessionRepository;
  readonly companies: CompanyRepository;
  readonly memberships: MembershipRepository;
  readonly roles: RoleRepository;
  readonly audit: AuditRepository;
  readonly authThrottle: AuthThrottleRepository;
}

/**
 * Thrown when a write names a capability the catalogue does not define.
 *
 * Section 2.7 replaces a foreign key with two checks, and this is the first: configuration
 * cannot invent a capability. It is an error rather than a silent skip, because a grant that
 * quietly does nothing looks granted on the administration screen and is not.
 */
export class UnknownPermissionError extends Error {
  constructor(readonly permissions: readonly string[]) {
    super(`Not in the permission catalogue: ${permissions.join(', ')}`);
    this.name = 'UnknownPermissionError';
  }
}

/** Thrown when an optimistic locking check fails. Contract section 10.1. */
export class ConcurrencyConflictError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was modified by someone else. Re-read it and try again.`);
    this.name = 'ConcurrencyConflictError';
  }
}

/**
 * Thrown when a scoped operation finds nothing.
 *
 * Contract section 6.1: a failure at the tenant dimension is indistinguishable from the record
 * not existing. Callers get the same error either way, so identifiers cannot be probed to learn
 * what other tenants hold.
 */
export class RecordNotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} was not found`);
    this.name = 'RecordNotFoundError';
  }
}

/**
 * Thrown when a document number is asked of a sequence the company has not configured.
 *
 * Loud rather than self healing. Section 10.4 makes a sequence a per company, per document type
 * configuration, so a missing one is a provisioning gap, and silently creating it would issue
 * document one to a company that has been trading for a year.
 */
export class DocumentNumberSequenceMissingError extends Error {
  readonly docType: string;

  constructor(docType: string) {
    super(`No ${docType} number sequence is configured for this company`);
    this.name = 'DocumentNumberSequenceMissingError';
    this.docType = docType;
  }
}
