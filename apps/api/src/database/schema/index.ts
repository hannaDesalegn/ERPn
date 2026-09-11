/**
 * The whole schema, and the classifications the drift test checks it against.
 *
 * Each module declares its own tables and its own classification lists; this composes them. The
 * alternative, one growing file called `identity.ts` that ends up holding sales orders, is how a
 * schema stops being readable, and the alternative to that, a drift test that knows about only
 * some of the tables, is worse: it would pass while the tables it does not know about drifted.
 *
 * ADDING A MODULE MEANS ADDING IT HERE. The drift test compares the composed list against every
 * table in the live database, so a module left out of this file fails immediately rather than
 * quietly going unchecked. That is the intended failure.
 */

import {
  COMPANY_PARTITIONED_TABLES as IDENTITY_COMPANY_PARTITIONED_TABLES,
  GLOBAL_TABLES as IDENTITY_GLOBAL_TABLES,
  INFRASTRUCTURE_TABLES as IDENTITY_INFRASTRUCTURE_TABLES,
  NULLABLE_SCOPE_TABLES as IDENTITY_NULLABLE_SCOPE_TABLES,
  TENANT_SCOPED_TABLES as IDENTITY_TENANT_SCOPED_TABLES,
  VERSION_EXEMPT_TABLES as IDENTITY_VERSION_EXEMPT_TABLES,
  identitySchema,
} from './identity.js';
import {
  MASTER_DATA_COMPANY_PARTITIONED_TABLES,
  MASTER_DATA_TENANT_SCOPED_TABLES,
  MASTER_DATA_VERSION_EXEMPT_TABLES,
  masterDataSchema,
} from './master-data.js';
import {
  INVENTORY_COMPANY_PARTITIONED_TABLES,
  INVENTORY_TENANT_SCOPED_TABLES,
  INVENTORY_VERSION_EXEMPT_TABLES,
  inventorySchema,
} from './inventory.js';
import {
  SALES_COMPANY_PARTITIONED_TABLES,
  SALES_TENANT_SCOPED_TABLES,
  SALES_VERSION_EXEMPT_TABLES,
  salesSchema,
} from './sales.js';

/** Every Drizzle table in the database, keyed by its export name. */
export const databaseSchema = {
  ...identitySchema,
  ...masterDataSchema,
  ...salesSchema,
  ...inventorySchema,
};

/** Carry `tenant_id`, and row level security enabled and forced. */
export const TENANT_SCOPED_TABLES = [
  ...IDENTITY_TENANT_SCOPED_TABLES,
  ...MASTER_DATA_TENANT_SCOPED_TABLES,
  ...SALES_TENANT_SCOPED_TABLES,
  ...INVENTORY_TENANT_SCOPED_TABLES,
] as const;

/** Additionally partitioned by company, so they carry `company_id` as well. */
export const COMPANY_PARTITIONED_TABLES = [
  ...IDENTITY_COMPANY_PARTITIONED_TABLES,
  ...MASTER_DATA_COMPANY_PARTITIONED_TABLES,
  ...SALES_COMPANY_PARTITIONED_TABLES,
  ...INVENTORY_COMPANY_PARTITIONED_TABLES,
] as const;

/** Outside the tenant boundary, per the closed list in section 4.6. */
export const GLOBAL_TABLES = IDENTITY_GLOBAL_TABLES;

/** Exempt from `version`, each by one of the four shapes in section 4.2. */
export const VERSION_EXEMPT_TABLES = [
  ...IDENTITY_VERSION_EXEMPT_TABLES,
  ...MASTER_DATA_VERSION_EXEMPT_TABLES,
  ...SALES_VERSION_EXEMPT_TABLES,
  ...INVENTORY_VERSION_EXEMPT_TABLES,
] as const;

/** Not business tables, so section 4.2 does not govern them. */
export const INFRASTRUCTURE_TABLES = IDENTITY_INFRASTRUCTURE_TABLES;

/** Scope columns are nullable on this table alone, per section 7.3. */
export const NULLABLE_SCOPE_TABLES = IDENTITY_NULLABLE_SCOPE_TABLES;
