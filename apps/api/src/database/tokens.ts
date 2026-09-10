/**
 * Injection tokens, in their own file to break a circular import.
 *
 * `database.module.ts` provides `UnitOfWork`, and `unit-of-work.ts` needs the pool token. If the
 * token lived in the module, those two files would import each other, and the token would
 * evaluate to `undefined` at decoration time. That failure is quiet at build time and loud at
 * startup, which is exactly the kind of thing to design out rather than debug twice.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Injection token for the Drizzle handle. */
export const DATABASE = Symbol('DATABASE');
/** Injection token for the underlying pool, for shutdown and diagnostics only. */
export const DATABASE_POOL = Symbol('DATABASE_POOL');

export type Database = NodePgDatabase<Record<string, never>>;
