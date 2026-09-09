import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';

import { AppModule } from '../app.module.js';

describe('Health endpoint', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
