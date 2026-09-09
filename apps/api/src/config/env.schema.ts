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
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
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
