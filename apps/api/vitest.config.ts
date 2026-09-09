import { defineConfig } from 'vitest/config';
import { swcPlugin } from './vitest.shared.js';

/**
 * Unit tests. No database, no network, no containers.
 *
 * Integration tests live in `*.int.spec.ts` and are excluded here so that `npm run test`
 * stays runnable with nothing else started. They run under vitest.integration.config.ts,
 * which requires a real PostgreSQL, as contract sections 13.1 and 13.2 demand.
 */
export default defineConfig({
  plugins: [swcPlugin()],
  test: {
    globals: true,
    environment: 'node',
    root: './',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/*.int.spec.ts'],
    env: {
      // Unit tests build the Nest application graph, so configuration must validate. The pool
      // is constructed lazily and never connects, so a syntactically valid URL is enough and
      // no database is contacted.
      DATABASE_URL: 'postgresql://unit-test:unit-test@127.0.0.1:1/unit_test',
    },
  },
});
