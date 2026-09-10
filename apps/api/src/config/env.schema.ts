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

  // -----------------------------------------------------------------------------------
  // Authentication policy.
  //
  // Contract section 5.3, ratified 2026-09-10: authentication-time policy is deployment
  // level configuration, not per company, because authentication happens before any company
  // is known. Per-company overrides are a recorded future consideration.
  //
  // Every value below is here rather than in the authentication code so that raising a cost
  // or shortening a lifetime is a configuration change, reviewable on its own, with no
  // application logic touched. Section 5.2 requires the Argon2 parameters to be "recorded in
  // configuration and reviewed periodically", and this is that record.
  // -----------------------------------------------------------------------------------

  /**
   * Argon2id memory cost in KiB. Default 65536, meaning 64 MiB.
   *
   * Memory is the parameter that matters most against GPU and ASIC attack, because it is the
   * one an attacker cannot trade away. Raise this first when revisiting.
   */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8_192).max(1_048_576).default(65_536),

  /** Argon2id iterations. Default 3. Raise after memory when hardware improves. */
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(3),

  /**
   * Argon2id parallelism. Default 1.
   *
   * One is deliberate rather than conservative: the hashing runs on a request thread, and
   * higher parallelism buys little against an attacker while costing the server more under
   * concurrent logins.
   */
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

  /** Idle timeout in minutes. A session unused for this long is dead. Section 5.3. */
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(1).max(43_200).default(60),

  /**
   * Absolute lifetime in minutes, never extended by use. Section 5.3 requires both, because
   * an idle timeout alone lets a stolen session live indefinitely as long as it is used.
   */
  SESSION_ABSOLUTE_MINUTES: z.coerce.number().int().min(5).max(43_200).default(720),

  /**
   * Failed attempts before a scope is locked. Section 5.2 requires lockout but names no
   * number, so this is a conservative default rather than an invented architectural rule.
   */
  AUTH_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(100).default(10),

  /** Window in minutes over which failures accumulate toward the limit. */
  AUTH_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),

  /** How long a scope stays locked once the limit is reached. */
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),

  // -----------------------------------------------------------------------------------
  // Session cookie.
  //
  // Contract section 5.1: the client receives an opaque session identifier in an HttpOnly,
  // Secure, SameSite cookie. Only the Secure attribute is configurable, and only because a
  // browser will not send a Secure cookie over plain HTTP, which would make local
  // development impossible without a certificate.
  // -----------------------------------------------------------------------------------

  /**
   * Whether the session cookie carries the Secure attribute.
   *
   * Defaults to true, so the safe value is what you get by saying nothing. Setting it false
   * is a development affordance and the refinement below refuses it in production, because a
   * session cookie sent over plain HTTP is a session anyone on the path can take.
   *
   * HttpOnly and SameSite are NOT configurable. There is no deployment for which turning
   * either off is correct, and a setting invites someone to try.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * Origins allowed to make mutating requests, beyond the one the API is served from.
   *
   * Empty by default, which means same origin only. Section 14.4 requires the origin to be
   * checked server side; this is the escape hatch for a deployment that serves the frontend
   * from a different host, and it is a list of exact origins rather than a pattern, because a
   * pattern is how an origin check ends up matching `evil-example.com`.
   */
  TRUSTED_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(z.url({ protocol: /^https?$/ }))),
})
  .refine((env) => env.NODE_ENV !== 'production' || env.COOKIE_SECURE, {
    message: 'COOKIE_SECURE must not be false in production',
    path: ['COOKIE_SECURE'],
  })
  // A session whose idle timeout exceeds its absolute lifetime has no idle timeout at all,
  // which reads as a configured control and is not one. Section 5.3 requires both to apply.
  .refine((env) => env.SESSION_IDLE_MINUTES <= env.SESSION_ABSOLUTE_MINUTES, {
    message: 'SESSION_IDLE_MINUTES must not exceed SESSION_ABSOLUTE_MINUTES',
    path: ['SESSION_IDLE_MINUTES'],
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
