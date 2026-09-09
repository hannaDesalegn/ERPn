/**
 * The single configuration module. Contract section 15.2.
 *
 * Global so that no other module has to import it, and cached so that reading a value is
 * not a repeated environment lookup. `validateEnv` runs during module initialisation, so a
 * bad configuration fails the boot rather than the first request that happens to need it.
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      // No `envFilePath` in production. A .env file is a development convenience only;
      // deployed environments inject configuration directly. Contract section 15.5.
      ignoreEnvFile: process.env['NODE_ENV'] === 'production',
    }),
  ],
})
export class AppConfigModule {}
