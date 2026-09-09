/**
 * The database connection.
 *
 * One pool for the process, created at startup and closed on shutdown. Contract section
 * 15.6 wants application processes stateless and horizontally scalable, which means the pool
 * is per process and nothing is cached across requests here.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It exposes a raw Drizzle handle, and that handle
 * is not what feature code will use. Contract section 6.3 requires every query to be scoped by
 * tenant, company and actor, and requires that an unscoped query cannot be constructed through
 * the data layer's public interface. The scoped repository that enforces that is the next
 * increment. Until it exists, this handle is used only by infrastructure concerns such as the
 * readiness check and migrations.
 */

import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import type { Env } from '../config/env.schema.js';

/** Injection token for the Drizzle handle. */
export const DATABASE = Symbol('DATABASE');
/** Injection token for the underlying pool, for shutdown and diagnostics only. */
export const DATABASE_POOL = Symbol('DATABASE_POOL');

export type Database = NodePgDatabase<Record<string, never>>;

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Pool =>
        new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          // A connection attempt that hangs should fail rather than hold a request open
          // indefinitely. Ten seconds is long enough for a cold start and short enough that
          // a readiness probe reports unhealthy rather than timing out.
          connectionTimeoutMillis: 10_000,
        }),
    },
    {
      provide: DATABASE,
      inject: [DATABASE_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool),
    },
  ],
  exports: [DATABASE, DATABASE_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Closes the pool on SIGTERM so in-flight queries finish and connections are returned
   * rather than dropped. Contract section 15.4 expects a rolling deploy not to sever work.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
