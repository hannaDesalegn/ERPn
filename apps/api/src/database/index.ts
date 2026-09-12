/**
 * The public surface of the data layer.
 *
 * What is exported: the unit of work, the scope constructors, the repository interfaces, and
 * the domain errors. That is the whole supported API.
 *
 * What is deliberately NOT exported, and a test asserts it stays that way:
 *   - the repository implementations, so none can be constructed with a handle of your choosing
 *   - the Drizzle handle and the connection pool
 *   - anything that would let a caller issue a query without a scope
 *
 * Contract section 6.3: constructing an unscoped query must not be possible through the public
 * interface of the data layer. This file is that interface.
 */

export { UnitOfWork } from './unit-of-work.js';
export { actorScope, principalScope, systemScope, isActorScope } from './scope.js';
export type {
  ActorScope,
  PrincipalScope,
  Scope,
  SystemScope,
  SystemScopeReason,
} from './scope.js';
export {
  ConcurrencyConflictError,
  DocumentNumberSequenceMissingError,
  RecordNotFoundError,
  UnknownPermissionError,
} from './repositories/types.js';
export type {
  AllocatedDocumentNumber,
  AuditEventInput,
  AuditEventRecord,
  AuditRepository,
  CompanyRecord,
  CompanyRepository,
  ArchiveRequest,
  CustomerRecord,
  CustomerRepository,
  DocumentNumberSequenceRecord,
  DocumentNumberSequenceRepository,
  MembershipRecord,
  MembershipRepository,
  NewCustomer,
  NewDocumentNumberSequence,
  NewSalesOrder,
  NewProduct,
  NewSalesOrderLine,
  NewWarehouse,
  SalesOrderLineRecord,
  SalesOrderLineRepository,
  SalesOrderRecord,
  ProductRecord,
  ProductRepository,
  SalesOrderRepository,
  SalesOrderPage,
  SalesOrderPageQuery,
  SalesOrderPageRow,
  SalesOrderDraftUpdate,
  SalesOrderTotals,
  SalesOrderTransition,
  StockBalanceRecord,
  StockLedgerRepository,
  StockMovementRecord,
  NewStockMovement,
  RecordedMovement,
  StockAvailability,
  IdempotencyRecord,
  IdempotencyRepository,
  StoredResponse,
  StockReservationRecord,
  StockReservationRepository,
  NewStockReservation,
  WarehouseRecord,
  WarehouseRepository,
  PrincipalRepositories,
  RoleRecord,
  RoleRepository,
  ScopedRepositories,
  SystemRepositories,
  UserRecord,
  UserRepository,
} from './repositories/types.js';
