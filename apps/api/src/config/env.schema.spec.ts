import { validateEnv } from './env.schema.js';

/**
 * The minimum a valid environment must supply. DATABASE_URL has no default on purpose, so
 * every case below starts from this rather than from an empty object.
 */
const REQUIRED = {
  DATABASE_URL: 'postgresql://erp_app:secret@127.0.0.1:5432/erp_dev',
} as const;

describe('validateEnv', () => {
  it('applies development defaults when only the required values are set', () => {
    const env = validateEnv({ ...REQUIRED });

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it('coerces PORT from the string the environment actually provides', () => {
    // Environment variables are always strings. A schema that expects a number without
    // coercing is a schema that fails in every real deployment and passes in tests.
    const env = validateEnv({ ...REQUIRED, PORT: '8080' });

    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it('rejects a port outside the valid range', () => {
    expect(() => validateEnv({ ...REQUIRED, PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a port that is not a number', () => {
    expect(() => validateEnv({ ...REQUIRED, PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV rather than passing it through', () => {
    expect(() => validateEnv({ ...REQUIRED, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('reports every problem at once, not just the first', () => {
    // Fixing configuration one error per restart is slow. The message names all of them.
    expect(() =>
      validateEnv({ ...REQUIRED, NODE_ENV: 'nope', LOG_LEVEL: 'chatty' }),
    ).toThrow(/NODE_ENV[\s\S]*LOG_LEVEL/);
  });

  describe('DATABASE_URL', () => {
    it('is required, because a default would let a deployment point somewhere unintended', () => {
      expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
    });

    it('rejects a connection string that is not postgresql', () => {
      expect(() => validateEnv({ DATABASE_URL: 'mysql://user:pw@127.0.0.1:3306/erp' })).toThrow(
        /DATABASE_URL/,
      );
    });

    it('accepts both postgresql:// and postgres:// forms', () => {
      expect(validateEnv({ DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' }).DATABASE_URL).toBe(
        'postgres://u:p@127.0.0.1:5432/db',
      );
      expect(
        validateEnv({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db' }).DATABASE_URL,
      ).toBe('postgresql://u:p@127.0.0.1:5432/db');
    });
  });

  describe('authentication policy', () => {
    // Contract section 5.3: deployment level, validated at startup so a malformed security
    // setting fails the boot rather than the first login.
    it('applies the documented defaults', () => {
      const env = validateEnv({ ...REQUIRED });

      expect(env.ARGON2_MEMORY_KIB).toBe(65_536);
      expect(env.ARGON2_TIME_COST).toBe(3);
      expect(env.ARGON2_PARALLELISM).toBe(1);
      expect(env.SESSION_IDLE_MINUTES).toBe(60);
      expect(env.SESSION_ABSOLUTE_MINUTES).toBe(720);
      expect(env.AUTH_MAX_ATTEMPTS).toBe(10);
    });

    it('refuses an argon2 memory cost below the floor', () => {
      // A cost low enough to be cheap to attack is worse than no configuration at all,
      // because it looks deliberate.
      expect(() => validateEnv({ ...REQUIRED, ARGON2_MEMORY_KIB: '1024' })).toThrow(
        /ARGON2_MEMORY_KIB/,
      );
    });

    it('refuses an argon2 time cost below the floor', () => {
      expect(() => validateEnv({ ...REQUIRED, ARGON2_TIME_COST: '1' })).toThrow(
        /ARGON2_TIME_COST/,
      );
    });

    it('refuses an idle timeout longer than the absolute lifetime', () => {
      // An idle timeout that can never be reached is not a timeout. Both must apply, per 5.3.
      expect(() =>
        validateEnv({ ...REQUIRED, SESSION_IDLE_MINUTES: '600', SESSION_ABSOLUTE_MINUTES: '60' }),
      ).toThrow(/SESSION_IDLE_MINUTES/);
    });

    it('accepts an idle timeout equal to the absolute lifetime', () => {
      const env = validateEnv({
        ...REQUIRED,
        SESSION_IDLE_MINUTES: '60',
        SESSION_ABSOLUTE_MINUTES: '60',
      });

      expect(env.SESSION_IDLE_MINUTES).toBe(60);
    });

    it('refuses a lockout threshold low enough to lock out ordinary typos', () => {
      expect(() => validateEnv({ ...REQUIRED, AUTH_MAX_ATTEMPTS: '1' })).toThrow(
        /AUTH_MAX_ATTEMPTS/,
      );
    });
  });

  it('rejects a pool size outside the sane range', () => {
    expect(() => validateEnv({ ...REQUIRED, DATABASE_POOL_MAX: '0' })).toThrow(
      /DATABASE_POOL_MAX/,
    );
    expect(() => validateEnv({ ...REQUIRED, DATABASE_POOL_MAX: '500' })).toThrow(
      /DATABASE_POOL_MAX/,
    );
  });
});
