import { defineConfig } from 'vitest/config';
import { swcPlugin } from './vitest.shared.js';

/**
 * Integration tests. These require a real PostgreSQL and will fail loudly without one.
 *
 * Contract section 13.2: the database is never mocked in a test that asserts a business
 * invariant. Constraints, grants and row level security policies are the logic, and a fake
 * proves nothing about any of them.
 *
 * Locally: `npm run db:up`, then `npm run test:int`.
 * In CI: the PostgreSQL service container, see .github/workflows/ci.yml.
 *
 * DATABASE_URL is not defaulted here on purpose. A default would let these tests silently
 * pass against the wrong database, or appear to pass while testing nothing.
 */
export default defineConfig({
  plugins: [swcPlugin()],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.int.spec.ts'],
    // One file at a time. These share a single database, and the global tables in section 4.6
    // are shared by definition: users, sessions and auth_throttle have no tenant column to keep
    // two files apart. Teardown of the append-only audit table is a TRUNCATE, which would take
    // another file's rows with it. Serial execution is the honest way to run them.
    fileParallelism: false,
    // A connection attempt against a database that is not up should fail fast rather than
    // sit at the default timeout.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
