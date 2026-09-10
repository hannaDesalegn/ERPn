import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';
import { registerHttpPlugins } from './http/plugins.js';

/**
 * Process entry point.
 *
 * Fastify rather than Express. The deciding factor was not performance: the Express platform
 * package depends on multer, which carries unpatched denial of service advisories, and npm
 * overrides did not resolve them in this workspace. Contract section 14.8 requires the
 * dependency audit to pass, and section 14.9 says a control for a feature that does not exist
 * should be handled by not carrying the dependency at all. This application has no upload
 * surface, so the correct fix was to remove the dependency path rather than patch it.
 *
 * The global prefix is `api`, matching what the web client already expects from
 * `services/client.ts`. Health is excluded from the prefix so that container and load
 * balancer probes can use the conventional `/health` path.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  await registerHttpPlugins(app);

  // Both health routes sit outside the api prefix, at the conventional paths container
  // platforms and load balancers probe. Liveness and readiness are listed separately because
  // the exclusion matches a path, not a prefix.
  app.setGlobalPrefix('api', { exclude: ['health', 'health/ready'] });

  // Terminates in-flight work on SIGTERM rather than dropping connections, which is what a
  // container platform sends during a rolling deploy. Contract section 15.4.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  const host = config.get('HOST', { infer: true });

  await app.listen(port, host);

  Logger.log(`Listening on ${host}:${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // Nothing is running yet, so there is no logger context worth preserving. Fail loudly and
  // exit non-zero so the supervisor treats it as a failed start rather than a healthy exit.
  Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap');
  process.exit(1);
});
