import { ConfigService } from '@nestjs/config';

import { PasswordHasher, parsePhcParameters } from './password-hasher.js';

/**
 * Argon2 at production cost takes tens of milliseconds per hash by design, and these tests
 * hash many times. The cost parameters are configuration precisely so they can be lowered
 * here without touching application logic, which is the point being demonstrated.
 *
 * The security properties under test do not depend on the cost. What the cost buys is
 * resistance to offline brute force, which no unit test can assert anyway.
 */
interface TestParameters {
  ARGON2_MEMORY_KIB: number;
  ARGON2_TIME_COST: number;
  ARGON2_PARALLELISM: number;
}

const TEST_PARAMETERS: TestParameters = {
  ARGON2_MEMORY_KIB: 8_192,
  ARGON2_TIME_COST: 2,
  ARGON2_PARALLELISM: 1,
};

function hasherWith(overrides: Partial<TestParameters> = {}): PasswordHasher {
  const values: Record<string, unknown> = { ...TEST_PARAMETERS, ...overrides };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<never, true>;
  return new PasswordHasher(config);
}

describe('PasswordHasher', () => {
  const hasher = hasherWith();

  it('produces a PHC encoded argon2id hash, not a bare digest', async () => {
    const result = await hasher.hash('correct horse battery staple');

    expect(result.startsWith('$argon2id$')).toBe(true);
  });

  it('never returns the password inside the hash', async () => {
    const password = 'a-very-distinctive-password-value';

    const result = await hasher.hash(password);

    expect(result).not.toContain(password);
  });

  it('produces a different hash each time, because the salt is random', async () => {
    const [first, second] = await Promise.all([hasher.hash('same'), hasher.hash('same')]);

    expect(first).not.toBe(second);
  });

  it('verifies the correct password', async () => {
    const stored = await hasher.hash('correct-password');

    await expect(hasher.verify(stored, 'correct-password')).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hasher.hash('correct-password');

    await expect(hasher.verify(stored, 'wrong-password')).resolves.toBe(false);
  });

  it('rejects a password that differs only in case', async () => {
    const stored = await hasher.hash('CaseSensitive');

    await expect(hasher.verify(stored, 'casesensitive')).resolves.toBe(false);
  });

  describe('failure handling', () => {
    it.each([
      ['a malformed hash', 'not-a-hash'],
      ['an empty hash', ''],
      ['a truncated hash', '$argon2id$v=19$m=8192,t=2,p=1$'],
      ['a hash from another algorithm', '$2b$12$abcdefghijklmnopqrstuv'],
    ])('returns false for %s rather than throwing', async (_label, stored) => {
      // Throwing would let a caller distinguish a corrupt stored record from a wrong password,
      // which is a distinction worth denying. Contract section 5.2.
      await expect(hasher.verify(stored, 'anything')).resolves.toBe(false);
    });

    it('returns false for an empty password without consulting the hash', async () => {
      const stored = await hasher.hash('real');

      await expect(hasher.verify(stored, '')).resolves.toBe(false);
    });

    it('refuses to hash an empty password', async () => {
      await expect(hasher.hash('')).rejects.toThrow(/empty password/);
    });
  });

  describe('configuration', () => {
    it('uses the configured parameters, and records them in the hash', async () => {
      const configured = hasherWith({ ARGON2_MEMORY_KIB: 16_384, ARGON2_TIME_COST: 3 });

      const stored = await configured.hash('password');
      const parsed = parsePhcParameters(stored);

      expect(parsed).toEqual({ memoryCost: 16_384, timeCost: 3, parallelism: 1 });
    });

    it('exposes the parameters in force', () => {
      expect(hasher.currentParameters).toEqual({
        memoryCost: 8_192,
        timeCost: 2,
        parallelism: 1,
      });
    });

    it('still verifies a hash made with weaker parameters after the cost is raised', async () => {
      // This is what PHC encoding buys: raising a cost must not lock out every existing user.
      const weak = hasherWith({ ARGON2_MEMORY_KIB: 8_192, ARGON2_TIME_COST: 2 });
      const strong = hasherWith({ ARGON2_MEMORY_KIB: 16_384, ARGON2_TIME_COST: 3 });

      const stored = await weak.hash('password');

      await expect(strong.verify(stored, 'password')).resolves.toBe(true);
    });

    it('flags a hash made with weaker parameters as needing a rehash', async () => {
      const weak = hasherWith({ ARGON2_MEMORY_KIB: 8_192, ARGON2_TIME_COST: 2 });
      const strong = hasherWith({ ARGON2_MEMORY_KIB: 16_384, ARGON2_TIME_COST: 3 });

      const stored = await weak.hash('password');

      expect(strong.needsRehash(stored)).toBe(true);
      expect(weak.needsRehash(stored)).toBe(false);
    });

    it('flags an unparseable hash as needing a rehash rather than assuming it is fine', async () => {
      expect(hasher.needsRehash('garbage')).toBe(true);
    });
  });
});

describe('parsePhcParameters', () => {
  it('reads the cost parameters without touching the salt or digest', () => {
    const parsed = parsePhcParameters('$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$ZGlnZXN0');

    expect(parsed).toEqual({ memoryCost: 65_536, timeCost: 3, parallelism: 1 });
  });

  it.each(['', 'nonsense', '$argon2i$v=19$m=1,t=1,p=1$x$y'])(
    'returns null for %s',
    (input) => {
      expect(parsePhcParameters(input)).toBeNull();
    },
  );
});
