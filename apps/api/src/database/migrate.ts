/**
 * Migration entry point. Run with `npm run db:migrate`.
 *
 * A separate process from the API on purpose. Contract section 15.4: migrations run as a
 * gated deployment step, never automatically at application start, so that a rolling restart
 * cannot race a schema change.
 *
 * It reads its own configuration rather than the API's. `MIGRATION_DATABASE_URL` is the owning
 * role and must never be visible to the API process, so it deliberately does not appear in the
 * API's environment schema.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { MigrationError, runMigrations } from './migrator.js';

const envSchema = z.object({
  MIGRATION_DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'must be a postgresql:// connection string',
    ),
  /** Name of the application role that migrations grant to. */
  APP_DB_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/, 'must be a valid role name'),
});

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid migration configuration:\n${problems}`);
  }

  const dryRun = process.argv.includes('--dry-run');

  const result = await runMigrations({
    connectionString: parsed.data.MIGRATION_DATABASE_URL,
    migrationsDir: MIGRATIONS_DIR,
    appRole: parsed.data.APP_DB_ROLE,
    dryRun,
    log: (message) => console.log(message),
  });

  console.log(
    `Connected as ${result.connectedAs}. Applied ${result.applied.length}, already applied ${result.alreadyApplied.length}.`,
  );
}

main().catch((error: unknown) => {
  // A failed migration must fail the deployment step loudly and non-zero. The distinction
  // below exists so an operator sees a forward-only violation as the rule it is, rather than
  // as an unexplained stack trace.
  if (error instanceof MigrationError) {
    console.error(`Migration refused: ${error.message}`);
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
});
