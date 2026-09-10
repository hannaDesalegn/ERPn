import { hashSessionToken, issueSessionToken, tokenHashesMatch } from './session-token.js';

describe('session tokens', () => {
  it('issues a token and a hash that are not the same value', () => {
    const { token, tokenHash } = issueSessionToken();

    // The whole point: what the client holds and what the database holds must differ, so a
    // leak of the sessions table yields nothing usable. Contract section 5.1.
    expect(tokenHash).not.toBe(token);
  });

  it('issues a distinct token every time', () => {
    const issued = Array.from({ length: 50 }, () => issueSessionToken().token);

    expect(new Set(issued).size).toBe(50);
  });

  it('issues 256 bits of entropy, base64url encoded', () => {
    const { token } = issueSessionToken();

    // 32 bytes base64url encodes to 43 characters with no padding.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a hash the token cannot be read out of', () => {
    const { token, tokenHash } = issueSessionToken();

    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
  });

  it('hashes deterministically, so a presented token finds its session', () => {
    const { token, tokenHash } = issueSessionToken();

    expect(hashSessionToken(token)).toBe(tokenHash);
  });

  it('produces a different hash for a token differing by one character', () => {
    const a = hashSessionToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const b = hashSessionToken('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab');

    expect(a).not.toBe(b);
  });

  describe('tokenHashesMatch', () => {
    it('matches identical hashes', () => {
      const { tokenHash } = issueSessionToken();

      expect(tokenHashesMatch(tokenHash, tokenHash)).toBe(true);
    });

    it('rejects different hashes', () => {
      expect(tokenHashesMatch(issueSessionToken().tokenHash, issueSessionToken().tokenHash)).toBe(
        false,
      );
    });

    it('rejects a length mismatch without throwing', () => {
      // timingSafeEqual throws on unequal lengths, and a thrown error is itself a signal.
      expect(tokenHashesMatch('short', issueSessionToken().tokenHash)).toBe(false);
      expect(tokenHashesMatch('', '')).toBe(true);
    });
  });
});
