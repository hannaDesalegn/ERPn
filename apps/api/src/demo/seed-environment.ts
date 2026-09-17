/**
 * What the demo seed needs from the environment, and what it refuses.
 *
 * Separate from the API's environment schema for the reason the migration runner gives:
 * `MIGRATION_DATABASE_URL` is the owning role and must never appear in the API's configuration.
 * The seed needs it for one thing only, creating the tenant rows the application role cannot.
 *
 * REFUSES PRODUCTION OUTRIGHT. A demo environment is a set of known accounts sharing one known
 * password. There is no production deployment for which creating those is correct, so the check
 * is not a warning and not an override.
 *
 * THE PASSWORD COMES FROM THE ENVIRONMENT, NEVER FROM THIS REPOSITORY'S SOURCE. The local value
 * sits in `.env.example` beside the local database passwords, which is the existing convention
 * for values that are documented rather than secret.
 */

import { z } from 'zod';

/** Long enough that a documented demo password is not also a trivially guessable one. */
export const DEMO_PASSWORD_MIN_LENGTH = 12;

const schema = z.object({
  NODE_ENV: z.string().optional(),
  MIGRATION_DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
      'must be a postgresql:// connection string',
    ),
  DEMO_USER_PASSWORD: z
    .string()
    .min(DEMO_PASSWORD_MIN_LENGTH, `must be at least ${DEMO_PASSWORD_MIN_LENGTH} characters`),
});

export interface SeedEnvironment {
  migrationDatabaseUrl: string;
  demoPassword: string;
}

export function parseSeedEnvironment(env: Record<string, string | undefined>): SeedEnvironment {
  if (env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to create demo accounts with NODE_ENV=production');
  }

  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names the variable and the rule, never the value: one of these is a password.
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid demo seed configuration:\n${problems}`);
  }

  return {
    migrationDatabaseUrl: parsed.data.MIGRATION_DATABASE_URL,
    demoPassword: parsed.data.DEMO_USER_PASSWORD,
  };
}
