/**
 * Authentication.
 *
 * Contract section 5.4: authentication answers "who is this". It does not answer "what may they
 * do", and it does not resolve a company. Nothing here reads a tenant, company, role or
 * permission from the caller, and nothing here returns one.
 *
 * A service rather than a controller, deliberately. The HTTP surface, cookies and CSRF belong to
 * a later increment, and putting the rules here means they can be tested without a web server
 * and reused by anything that authenticates, including a future single sign on path.
 *
 * WHAT THIS FILE NEVER LOGS: the password, the password hash, the raw session token, and whether
 * a given email exists. The last one matters as much as the first two, because a log line that
 * says "no such user" is an enumeration oracle for anyone who can read logs.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env.schema.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import type {
  AuthThrottlePolicy,
  AuthThrottleScopeKind,
  SystemRepositories,
} from '../database/repositories/types.js';
import { PasswordHasher } from './password-hasher.js';
import {
  evaluateSession,
  extendIdleWindow,
  newSessionWindow,
  type SessionLifetimePolicy,
} from './session-policy.js';
import { hashSessionToken, issueSessionToken } from './session-token.js';

export interface LoginRequest {
  email: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** What a successful login returns. Deliberately small. */
export interface LoginSuccess {
  outcome: 'authenticated';
  /** The raw token, for the caller to put in a cookie. Never stored, never logged. */
  token: string;
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Why a login failed.
 *
 * The distinction exists for audit and for the throttle, not for the client. A caller putting
 * this on the wire must collapse `invalid_credentials` and anything else that could reveal
 * whether an account exists into one message, per section 5.2.
 */
export type LoginFailureReason = 'invalid_credentials' | 'locked_out' | 'account_disabled';

export interface LoginFailure {
  outcome: 'rejected';
  reason: LoginFailureReason;
  /** Present when locked. A caller may surface "try again later" without saying why. */
  retryAfter?: Date;
}

export type LoginResult = LoginSuccess | LoginFailure;

export type SessionValidationResult =
  | { outcome: 'valid'; sessionId: string; userId: string }
  | { outcome: 'invalid' };

@Injectable()
export class AuthenticationService {
  private readonly sessionPolicy: SessionLifetimePolicy;
  private readonly throttlePolicy: AuthThrottlePolicy;
  private decoy: Promise<string> | null = null;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly passwords: PasswordHasher,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.sessionPolicy = {
      idleMinutes: config.get('SESSION_IDLE_MINUTES', { infer: true }),
      absoluteMinutes: config.get('SESSION_ABSOLUTE_MINUTES', { infer: true }),
    };
    this.throttlePolicy = {
      maxAttempts: config.get('AUTH_MAX_ATTEMPTS', { infer: true }),
      windowMinutes: config.get('AUTH_WINDOW_MINUTES', { infer: true }),
      lockoutMinutes: config.get('AUTH_LOCKOUT_MINUTES', { infer: true }),
    };
  }

  /**
   * Verifies credentials and, on success, creates a session.
   *
   * Everything happens in one transaction. Contract section 7.1 requires the audit record to be
   * written inside the same transaction as the change it describes, which means a session that
   * exists without its audit row is impossible, and so is the reverse. A failure anywhere rolls
   * the whole thing back, including the session.
   */
  async login(request: LoginRequest): Promise<LoginResult> {
    const email = request.email.trim().toLowerCase();
    const address = request.ipAddress ?? 'unknown';

    return this.uow.inSystemScope(systemScope('authentication'), async (repos) => {
      // Throttle first, before touching the user table. A locked scope must not even reach the
      // password comparison, or the lockout would still leak timing about whether the account
      // exists and would still burn argon2 cycles on an attacker's behalf.
      const locked = await this.checkLocked(repos, email, address);
      if (locked) {
        await this.auditFailure(repos, email, request, 'locked_out');
        return { outcome: 'rejected', reason: 'locked_out', retryAfter: locked };
      }

      const user = await repos.users.findByEmail(email);
      const storedHash = user ? await this.storedHashFor(repos, user.id) : null;

      // The hash is verified even when no user was found, against a throwaway value. Without
      // this, a missing account returns fast and a wrong password returns slowly, and the
      // difference is an enumeration oracle that no amount of identical wording hides.
      const passwordMatches = await this.passwords.verify(
        storedHash ?? (await this.decoyHash()),
        request.password,
      );

      if (!user || !storedHash || !passwordMatches) {
        await this.recordFailure(repos, email, address);
        await this.auditFailure(repos, email, request, 'invalid_credentials');
        return { outcome: 'rejected', reason: 'invalid_credentials' };
      }

      if (user.status !== 'active') {
        // Counted as a failure too. An attacker who learns that a disabled account behaves
        // differently has learned the account exists.
        await this.recordFailure(repos, email, address);
        await this.auditFailure(repos, email, request, 'account_disabled');
        return { outcome: 'rejected', reason: 'invalid_credentials' };
      }

      const now = new Date();
      const window = newSessionWindow(this.sessionPolicy, now);
      const issued = issueSessionToken();
      const sessionId = randomUUID();

      await repos.sessions.create({
        id: sessionId,
        userId: user.id,
        tokenHash: issued.tokenHash,
        idleExpiresAt: window.idleExpiresAt,
        absoluteExpiresAt: window.absoluteExpiresAt,
        ipAddress: request.ipAddress ?? null,
        userAgent: request.userAgent ?? null,
      });

      // Only now, and only when not locked. A correct password part way through a lockout
      // never reaches here, because the check above returned first.
      await repos.authThrottle.clearOnSuccess('account', email);
      await repos.authThrottle.clearOnSuccess('address', address);

      await repos.audit.append({
        action: 'logged_in',
        entityType: 'user',
        entityId: user.id,
        summary: `Signed in as ${user.email}`,
        requestId: null,
        ipAddress: request.ipAddress ?? null,
        userAgent: request.userAgent ?? null,
      });

      return {
        outcome: 'authenticated',
        token: issued.token,
        sessionId,
        userId: user.id,
        expiresAt: window.idleExpiresAt,
      };
    });
  }

  /**
   * Ends a session server side.
   *
   * Takes a token rather than a session id, because the caller holds a cookie and nothing else.
   * Revoking an already dead session is not an error: logging out twice is a normal thing for a
   * person to do and should not produce a failure.
   */
  async logout(token: string): Promise<void> {
    await this.uow.inSystemScope(systemScope('authentication'), async (repos) => {
      const session = await repos.sessions.findByTokenHash(hashSessionToken(token));
      if (!session) return;

      await repos.sessions.revoke(session.id);

      await repos.audit.append({
        action: 'logged_out',
        entityType: 'user',
        entityId: session.userId,
        summary: 'Signed out',
      });
    });
  }

  /**
   * Validates a presented token and extends the idle window if it is still good.
   *
   * Contract section 5.3: expiry is checked on every request rather than trusted from a cookie
   * attribute. This is the function that does that checking.
   *
   * Returns only whether the session is valid and whose it is. Company and permissions are a
   * later increment and are deliberately absent.
   */
  async validate(token: string): Promise<SessionValidationResult> {
    return this.uow.inSystemScope(systemScope('authentication'), async (repos) => {
      const session = await repos.sessions.findByTokenHash(hashSessionToken(token));
      if (!session) return { outcome: 'invalid' };

      const now = new Date();
      const rejection = evaluateSession(session, now);
      if (rejection) return { outcome: 'invalid' };

      // Sliding idle window, clamped to the absolute expiry inside the policy helper so that
      // constant use cannot extend a session past its hard limit.
      await repos.sessions.touch({
        id: session.id,
        idleExpiresAt: extendIdleWindow(this.sessionPolicy, session, now),
      });

      return { outcome: 'valid', sessionId: session.id, userId: session.userId };
    });
  }

  /** Revokes every live session for a user. Used by password change and by dismissal. */
  async revokeAllSessionsForUser(userId: string): Promise<number> {
    return this.uow.inSystemScope(systemScope('authentication'), async (repos) => {
      const revoked = await repos.sessions.revokeAllForUser(userId);

      if (revoked > 0) {
        await repos.audit.append({
          action: 'logged_out',
          entityType: 'user',
          entityId: userId,
          summary: `Revoked ${revoked} session${revoked === 1 ? '' : 's'}`,
        });
      }

      return revoked;
    });
  }

  private async checkLocked(
    repos: SystemRepositories,
    email: string,
    address: string,
  ): Promise<Date | null> {
    const scopes: [AuthThrottleScopeKind, string][] = [
      ['account', email],
      ['address', address],
    ];

    for (const [kind, key] of scopes) {
      const status = await repos.authThrottle.status(kind, key);
      if (status.lockedUntil) return status.lockedUntil;
    }

    return null;
  }

  private async recordFailure(
    repos: SystemRepositories,
    email: string,
    address: string,
  ): Promise<void> {
    // Both dimensions, per section 5.2. An attacker spreading attempts across accounts still
    // trips the address limit; one spreading across addresses still trips the account limit.
    await repos.authThrottle.recordFailure('account', email, this.throttlePolicy);
    await repos.authThrottle.recordFailure('address', address, this.throttlePolicy);
  }

  private async auditFailure(
    repos: SystemRepositories,
    email: string,
    request: LoginRequest,
    reason: LoginFailureReason,
  ): Promise<void> {
    // The attempted address is recorded, because an audit trail of failed logins that does not
    // say what was attempted is not much of a trail. It goes to the audit table, which section
    // 2.8 reserves for platform administration, not to a log line or to the client.
    await repos.audit.append({
      action: 'login_failed',
      entityType: 'user',
      entityId: null,
      summary: `Failed sign in for ${email}`,
      changes: { reason },
      ipAddress: request.ipAddress ?? null,
      userAgent: request.userAgent ?? null,
    });
  }

  /**
   * Reads the stored hash, which the user repository deliberately does not expose.
   *
   * `UserRecord` has no `passwordHash` field, so a hash cannot reach a caller by accident
   * through any ordinary lookup. This is the one place that needs it, and it fetches it
   * narrowly rather than widening the record for everyone.
   */
  private async storedHashFor(repos: SystemRepositories, userId: string): Promise<string | null> {
    return repos.users.findPasswordHash(userId);
  }

  /**
   * A real argon2id hash of a value nobody knows, verified against when no account was found.
   *
   * It has to be a REAL hash produced with the CONFIGURED parameters. A hand written string
   * that argon2 rejects while parsing returns almost immediately, which reinstates exactly the
   * fast path it was supposed to remove and makes the defence worse than useless, because it
   * looks present in review.
   *
   * Built once, lazily, and never at module load: the cost parameters come from configuration,
   * which is not available until the container has constructed this service. The promise is
   * cached rather than the string so that concurrent first logins share one hashing operation
   * instead of racing to compute the same value.
   *
   * The input is random per process. Nothing depends on its value, and a fixed literal here
   * would be a credential shaped constant in source for someone to misread later.
   */
  private decoyHash(): Promise<string> {
    this.decoy ??= this.passwords.hash(randomBytes(32).toString('base64url'));
    return this.decoy;
  }
}
