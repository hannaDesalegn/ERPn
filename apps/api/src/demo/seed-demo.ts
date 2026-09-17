/**
 * Demo seed entry point. Run with `npm run db:seed:demo`, after `npm run db:migrate`.
 *
 * A separate process from the API, like the migration runner, and for a similar reason: it holds
 * the owning role's connection string, which the API process must never see. It uses that
 * connection only to check for and create the demo tenants. Everything else runs through the
 * application's unit of work as the restricted application role.
 */

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';

import { DemoSeedModule } from './demo-seed.module.js';
import { DemoAlreadySeededError, DemoSeedService, type DemoPlatform } from './demo-seed.service.js';
import { parseSeedEnvironment } from './seed-environment.js';

async function main(): Promise<void> {
  const env = parseSeedEnvironment(process.env);

  const owner = new Client({ connectionString: env.migrationDatabaseUrl });
  await owner.connect();

  const app = await NestFactory.createApplicationContext(DemoSeedModule, {
    logger: ['error', 'warn'],
  });

  try {
    const platform: DemoPlatform = {
      async existingTenantSlugs(slugs) {
        const result = await owner.query<{ slug: string }>(
          'SELECT slug FROM tenants WHERE slug = ANY($1) ORDER BY slug',
          [slugs],
        );
        return result.rows.map((row) => row.slug);
      },
      async createTenant(tenant) {
        await owner.query('INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $3)', [
          tenant.id,
          tenant.slug,
          tenant.name,
        ]);
      },
    };

    const report = await app.get(DemoSeedService).seed({
      platform,
      password: env.demoPassword,
    });

    console.log('Demo environment created.\n');
    for (const tenant of report.tenants) {
      console.log(`Tenant ${tenant.name} (${tenant.slug}): ${tenant.companies.join(', ')}`);
    }
    console.log('\nAccounts, all using DEMO_USER_PASSWORD:');
    for (const account of report.accounts) {
      const held = account.memberships.map((m) => `${m.role} in ${m.company}`).join('; ');
      console.log(`  ${account.email.padEnd(30)} ${held}`);
    }
    console.log('\nOpening stock:');
    for (const line of report.openingStock) {
      console.log(`  ${line.company.padEnd(24)} ${line.sku.padEnd(10)} ${line.quantity} ${line.uom}`);
    }
  } finally {
    await app.close();
    await owner.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof DemoAlreadySeededError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  process.exit(1);
});
