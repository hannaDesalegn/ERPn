/**
 * Environment configuration, validated once at startup.
 *
 * Architecture contract section 15.2: configuration comes from the environment, a single
 * module reads and validates it at startup, and the process fails fast on anything missing
 * or malformed. A server that boots with a half valid configuration fails later, in
 * production, under load, in a way nobody can attribute.
 *
 * Nothing in this file has a production default. Defaults exist only for values that are
 * genuinely safe to assume in development. Secrets never appear here at all: contract
 * section 15.5 keeps them in the secret store, injected at runtime.
 */

import { z } from 'zod';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  /** Port the HTTP server binds to. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Interface the HTTP server binds to.
   *
   * Defaults to loopback, which is the safe default: a developer machine does not expose the
   * API to its local network by accident. A container must set this to 0.0.0.0 explicitly,
   * because Fastify binds only to the given interface and a container that binds loopback is
   * unreachable from outside itself. Explicit opt in rather than open by default.
   */
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  /**
   * PostgreSQL connection string for the RESTRICTED APPLICATION ROLE.
   *
   * Contract sections 2.4 and 7.1: the API never connects as the role that owns objects.
   * The owning role runs migrations and is configured separately, so a misconfigured API
   * cannot issue DDL or escape row level security even if someone points it at the wrong
   * database.
   *
   * No default. A database connection string is environment specific by definition, and a
   * default here would let a deployment silently come up pointing somewhere unintended.
   */
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'must be a postgresql:// connection string',
    ),

  /** Connection pool ceiling. Kept small by default; tuned against real load later. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Passed to ConfigModule as its validator. Throwing here aborts the boot, which is the
 * intended behaviour: an invalid configuration is not something to warn about and continue.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return result.data;
}
