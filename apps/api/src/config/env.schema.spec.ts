import { validateEnv } from './env.schema.js';

describe('validateEnv', () => {
  it('applies development defaults when nothing is set', () => {
    const env = validateEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from the string the environment actually provides', () => {
    // Environment variables are always strings. A schema that expects a number without
    // coercing is a schema that fails in every real deployment and passes in tests.
    const env = validateEnv({ PORT: '8080' });

    expect(env.PORT).toBe(8080);
    expect(typeof env.PORT).toBe('number');
  });

  it('rejects a port outside the valid range', () => {
    expect(() => validateEnv({ PORT: '70000' })).toThrow(/PORT/);
  });

  it('rejects a port that is not a number', () => {
    expect(() => validateEnv({ PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV rather than passing it through', () => {
    expect(() => validateEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('reports every problem at once, not just the first', () => {
    // Fixing configuration one error per restart is slow. The message names all of them.
    expect(() => validateEnv({ NODE_ENV: 'nope', LOG_LEVEL: 'chatty' })).toThrow(
      /NODE_ENV[\s\S]*LOG_LEVEL/,
    );
  });
});
