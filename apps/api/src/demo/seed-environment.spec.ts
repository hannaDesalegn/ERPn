import { parseSeedEnvironment } from './seed-environment.js';

const VALID = {
  MIGRATION_DATABASE_URL: 'postgresql://erp_migrator:x@127.0.0.1:5432/erp_dev',
  DEMO_USER_PASSWORD: 'long enough to use',
};

describe('The demo seed environment', () => {
  it('accepts a local configuration', () => {
    expect(parseSeedEnvironment({ ...VALID, NODE_ENV: 'development' })).toEqual({
      migrationDatabaseUrl: VALID.MIGRATION_DATABASE_URL,
      demoPassword: VALID.DEMO_USER_PASSWORD,
    });
  });

  it('refuses to run in production, however complete the configuration is', () => {
    expect(() => parseSeedEnvironment({ ...VALID, NODE_ENV: 'production' })).toThrow(/production/);
  });

  it('refuses without a demo password rather than inventing one', () => {
    expect(() =>
      parseSeedEnvironment({ MIGRATION_DATABASE_URL: VALID.MIGRATION_DATABASE_URL }),
    ).toThrow(/DEMO_USER_PASSWORD/);
  });

  it('refuses a short demo password', () => {
    expect(() => parseSeedEnvironment({ ...VALID, DEMO_USER_PASSWORD: 'short' })).toThrow(
      /at least 12/,
    );
  });

  it('never repeats the password in its refusal', () => {
    const password = 'shortpw';
    expect(() => parseSeedEnvironment({ ...VALID, DEMO_USER_PASSWORD: password })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(password) }),
    );
  });

  it('refuses without the owning connection it needs to create tenants', () => {
    expect(() => parseSeedEnvironment({ DEMO_USER_PASSWORD: VALID.DEMO_USER_PASSWORD })).toThrow(
      /MIGRATION_DATABASE_URL/,
    );
  });
});
