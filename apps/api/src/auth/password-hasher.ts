/**
 * Password hashing.
 *
 * Contract section 5.2: passwords hashed with argon2id, with parameters recorded in
 * configuration and reviewed periodically.
 *
 * `@node-rs/argon2` rather than the node-gyp based `argon2` package. Both implement the same
 * algorithm; the difference is that this one ships prebuilt binaries, so neither a developer
 * machine nor a CI runner needs a C toolchain. Nothing here implements any cryptography: the
 * algorithm is argon2id as published, and this class only chooses parameters and handles
 * failure.
 *
 * NOTHING IN THIS FILE LOGS. Not the password, not the hash, not the parameters at call time.
 * A hash in a log is a hash an attacker can take offline, and the usual way one gets there is a
 * well meaning debug line during an incident.
 */

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Algorithm, hash, verify } from '@node-rs/argon2';

import type { Env } from '../config/env.schema.js';

export interface Argon2Parameters {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

@Injectable()
export class PasswordHasher {
  private readonly parameters: Argon2Parameters;

  constructor(@Inject(ConfigService) config: ConfigService<Env, true>) {
    this.parameters = {
      memoryCost: config.get('ARGON2_MEMORY_KIB', { infer: true }),
      timeCost: config.get('ARGON2_TIME_COST', { infer: true }),
      parallelism: config.get('ARGON2_PARALLELISM', { infer: true }),
    };
  }

  /** The parameters in force, for diagnostics and tests. Never for logging at call time. */
  get currentParameters(): Readonly<Argon2Parameters> {
    return this.parameters;
  }

  async hash(password: string): Promise<string> {
    if (password.length === 0) {
      throw new Error('Refusing to hash an empty password');
    }

    // The returned string is the PHC encoded hash: it carries the algorithm, the parameters
    // and the salt alongside the digest. That is what makes raising a cost later possible
    // without invalidating existing passwords, because each hash remembers how it was made.
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.parameters.memoryCost,
      timeCost: this.parameters.timeCost,
      parallelism: this.parameters.parallelism,
    });
  }

  /**
   * Verifies a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed or unreadable hash. A stored hash that
   * cannot be parsed is a data problem, and turning it into an exception on the login path
   * would give a caller a way to tell a corrupt record from a wrong password, which is a
   * distinction worth denying them. Section 5.2 wants failures indistinguishable.
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    if (!storedHash || !password) return false;

    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Whether a stored hash was made with weaker parameters than the current configuration.
   *
   * Section 5.2 expects the parameters to be reviewed and raised over time. Raising them helps
   * nobody whose password was hashed before the change unless something re-hashes on next
   * successful login, and this is how that decision gets made.
   */
  needsRehash(storedHash: string): boolean {
    const parsed = parsePhcParameters(storedHash);
    if (!parsed) return true;

    return (
      parsed.memoryCost < this.parameters.memoryCost ||
      parsed.timeCost < this.parameters.timeCost ||
      parsed.parallelism !== this.parameters.parallelism
    );
  }
}

/**
 * Reads the cost parameters out of a PHC encoded argon2 hash.
 *
 * Format: `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<digest>`. Only the parameter segment is read;
 * the salt and digest are never touched here.
 */
export function parsePhcParameters(storedHash: string): Argon2Parameters | null {
  const match = /\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match?.[1] || !match[2] || !match[3]) return null;

  return {
    memoryCost: Number(match[1]),
    timeCost: Number(match[2]),
    parallelism: Number(match[3]),
  };
}
