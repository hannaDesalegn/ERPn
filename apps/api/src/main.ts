import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';

/**
 * Process entry point.
 *
 * The global prefix is `api`, matching what the web client already expects from
 * `services/client.ts`. Health is excluded from the prefix so that container and load
 * balancer probes can use the conventional `/health` path.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api', { exclude: ['health'] });

  // Terminates in-flight work on SIGTERM rather than dropping connections, which is what a
  // container platform sends during a rolling deploy. Contract section 15.4.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);

  Logger.log(`Listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  // Nothing is running yet, so there is no logger context worth preserving. Fail loudly and
  // exit non-zero so the supervisor treats it as a failed start rather than a healthy exit.
  Logger.error(error instanceof Error ? error.stack : String(error), 'Bootstrap');
  process.exit(1);
});
