/**
 * The migration runner.
 *
 * Contract section 1.2, ratified: handwritten versioned SQL applied by a small runner built on
 * the existing `pg` dependency. Forward only, checksummed, run as the owning role, never at
 * application start.
 *
 * The design splits deliberately into a pure part and an IO part. `planMigrations` holds every
 * forward-only rule and takes plain data, so the rules that decide whether a deployment is safe
 * are testable without a database and without a filesystem. `runMigrations` does the talking.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Client } from 'pg';

/**
 * Advisory lock key, chosen once and never changed. Two runners starting at the same moment,
 * which is what a rolling deploy of two replicas looks like, must not both apply the same
 * migration. The second waits and then finds nothing pending.
 */
const MIGRATION_LOCK_KEY = 8_274_630_912_837_465n;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  /** Zero padded ordinal, for example `0001`. Sorts lexicographically and numerically alike. */
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  version: string;
  checksum: string;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  alreadyApplied: string[];
}

/** Thrown for every condition that must stop a deployment rather than be worked around. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function checksumOf(sql: string): string {
  // Line endings are normalised first. A checkout on Windows can rewrite LF to CRLF, and a
  // migration must not appear modified because of how it was cloned.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function parseMigrationFilename(filename: string): { version: string; name: string } {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match?.[1] || !match[2]) {
    throw new MigrationError(
      `Migration filename "${filename}" is not valid. Expected NNNN_lower_snake_case.sql, for example 0001_identity.sql.`,
    );
  }
  return { version: match[1], name: match[2] };
}

/** Reads and checksums every migration in a directory, in version order. */
export async function readMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.sql')).sort();

  const files: MigrationFile[] = [];
  const seen = new Map<string, string>();

  for (const filename of entries) {
    const { version, name } = parseMigrationFilename(filename);

    const duplicate = seen.get(version);
    if (duplicate) {
      throw new MigrationError(
        `Two migrations share version ${version}: "${duplicate}" and "${filename}". Versions must be unique.`,
      );
    }
    seen.set(version, filename);

    const sql = await readFile(path.join(directory, filename), 'utf8');
    files.push({ version, name, filename, sql, checksum: checksumOf(sql) });
  }

  return files;
}

/**
 * Decides what to apply, and refuses anything that would let two environments diverge.
 *
 * Pure. Every rule below is a way a deployment can silently produce a different schema in
 * production than in development, which is precisely the class of failure a migration runner
 * exists to prevent.
 */
export function planMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
): MigrationPlan {
  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));
  const fileVersions = new Set(files.map((file) => file.version));

  // A migration that was applied and whose file is now gone. The database holds a schema
  // nobody can reproduce from the repository.
  for (const row of applied) {
    if (!fileVersions.has(row.version)) {
      throw new MigrationError(
        `Migration ${row.version} is recorded as applied but its file is missing. An applied migration must never be deleted.`,
      );
    }
  }

  // A migration that was applied and has since been edited. The database and the file now
  // disagree, and every environment applied after the edit gets a different schema.
  for (const file of files) {
    const row = appliedByVersion.get(file.version);
    if (row && row.checksum !== file.checksum) {
      throw new MigrationError(
        `Migration ${file.filename} has changed since it was applied. Migrations are forward only: add a new migration instead of editing ${file.version}.`,
      );
    }
  }

  const pending = files.filter((file) => !appliedByVersion.has(file.version));

  // A pending migration numbered below one already applied. This happens when two branches
  // add migrations concurrently and the lower numbered one merges second. Applying it now
  // would give this database a different order than the one that already ran the higher
  // number, so the numbering is corrected rather than the difference tolerated.
  const highestApplied = applied
    .map((row) => row.version)
    .sort()
    .at(-1);

  if (highestApplied) {
    const outOfOrder = pending.filter((file) => file.version < highestApplied);
    if (outOfOrder.length > 0) {
      throw new MigrationError(
        `Migration ${outOfOrder[0]?.filename} is numbered below ${highestApplied}, which is already applied. Renumber it above the highest applied migration.`,
      );
    }
  }

  return {
    pending,
    alreadyApplied: applied.map((row) => row.version).sort(),
  };
}

export interface RunMigrationsOptions {
  /** Connection string for the OWNING role. Never the application role. */
  connectionString: string;
  migrationsDir: string;
  /**
   * Name of the application role that migrations grant to. Exposed to SQL as
   * `app.provision_role`, so a migration writes its grants without hardcoding a role name that
   * differs between environments.
   */
  appRole: string;
  /**
   * Schema to operate in. Defaults to `public`. Tests point this at a throwaway schema so each
   * case starts from nothing without needing a database of its own.
   */
  schema?: string;
  /** Set false to plan without applying. Used to report drift without changing anything. */
  dryRun?: boolean;
  log?: (message: string) => void;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
  connectedAs: string;
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const { connectionString, migrationsDir, appRole } = options;
  const schema = options.schema ?? 'public';
  const log = options.log ?? (() => {});

  const files = await readMigrationFiles(migrationsDir);
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);

    const who = await client.query<{ user: string; superuser: boolean }>(
      `SELECT current_user AS user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`,
    );
    const connectedAs = who.rows[0]?.user ?? 'unknown';

    // The owning role must not be a superuser. Contract section 7.1: a superuser bypasses row
    // level security even with FORCE, which would leave the policies a migration creates
    // unenforceable against the role that created them, and any test of them meaningless.
    if (who.rows[0]?.superuser) {
      throw new MigrationError(
        `Refusing to run migrations as "${connectedAs}", which is a superuser. A superuser bypasses row level security, so policies created here could not be verified. Use the owning role.`,
      );
    }

    // Serialises concurrent runners. Released automatically when the connection closes, so a
    // crashed runner does not leave the lock held.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);

    // A dry run must leave the database exactly as it found it, including not creating the
    // runner's own bookkeeping table. Against a database that has never been migrated there is
    // nothing to read, so an absent table means nothing has been applied.
    if (!options.dryRun) {
      await ensureMigrationsTable(client);
    }

    const applied = (await migrationsTableExists(client))
      ? await readAppliedMigrations(client)
      : [];
    const plan = planMigrations(files, applied);

    if (plan.pending.length === 0) {
      log(`No pending migrations. ${plan.alreadyApplied.length} already applied.`);
      return { applied: [], alreadyApplied: plan.alreadyApplied, connectedAs };
    }

    if (options.dryRun) {
      log(`Dry run. Pending: ${plan.pending.map((file) => file.filename).join(', ')}`);
      return { applied: [], alreadyApplied: plan.alreadyApplied, connectedAs };
    }

    const appliedNow: string[] = [];

    for (const file of plan.pending) {
      // One transaction per migration. The schema change and the record of it commit together
      // or not at all, so the runner can never believe a migration ran that did not.
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}`);
        await client.query('SELECT set_config($1, $2, true)', ['app.provision_role', appRole]);
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [file.version, file.checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new MigrationError(
          `Migration ${file.filename} failed and was rolled back: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      appliedNow.push(file.version);
      log(`Applied ${file.filename}`);
    }

    return { applied: appliedNow, alreadyApplied: plan.alreadyApplied, connectedAs };
  } finally {
    await client.end();
  }
}

/**
 * Bootstraps the runner's own table.
 *
 * `0001_identity.sql` also declares it with IF NOT EXISTS, which makes that statement a no-op
 * once this has run. The duplication is intentional: the runner cannot record state in a table
 * that only exists after the first migration it is supposed to record.
 */
async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text        NOT NULL DEFAULT current_user
    )
  `);
}

/** Resolved through the current search_path, so it answers for the schema being migrated. */
async function migrationsTableExists(client: Client): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT to_regclass('schema_migrations') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists ?? false;
}

async function readAppliedMigrations(client: Client): Promise<AppliedMigration[]> {
  const result = await client.query<AppliedMigration>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return result.rows;
}

/** Schema names come from configuration, not from a request, but quoting is free. */
function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new MigrationError(`Invalid schema name "${identifier}".`);
  }
  return `"${identifier}"`;
}
