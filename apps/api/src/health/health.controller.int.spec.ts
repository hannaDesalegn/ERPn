/**
 * The health routes, booted from the real root module.
 *
 * An integration test rather than a unit one, and it became so on purpose. Booting the whole
 * application now runs two startup checks that read the database: the catalogue integrity check
 * in section 2.7 and the route declaration audit in section 6.2. Stubbing them out to keep this
 * fast would leave nothing asserting that the real route set passes the audit, which is half of
 * criterion 7. So it keeps the real graph and takes the database with it.
 */

import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';

import { AppModule } from '../app.module.js';
import { registerHttpPlugins } from '../http/plugins.js';

describe('Health endpoint', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // The same plugin registration the entry point performs. Leaving it out gave a server
    // whose replies could not set a cookie, which surfaced as a 500 on the health probe.
    await registerHttpPlugins(app);
    // Mirrors main.ts so the test exercises the paths the application actually serves.
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();
    // Fastify builds its router lazily. Without this the underlying server is not yet
    // listening and every request would 404 for the wrong reason.
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health outside the api prefix, where probes look for it', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({
      status: 'ok',
      uptimeSeconds: expect.any(Number),
    });
  });

  it('does not also serve health under the api prefix', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(404);
  });

  it('returns 404 for an unknown route', async () => {
    await request(app.getHttpServer()).get('/api/does-not-exist').expect(404);
  });
});
