/**
 * Readiness, as distinct from liveness.
 *
 * `/health` answers "is this process alive" and checks nothing else, deliberately. `/health/ready`
 * answers "can this process actually serve traffic", which means its dependencies must respond.
 *
 * The distinction is operational, not pedantic. A liveness probe that fails when the database is
 * down causes the orchestrator to kill and restart healthy processes during a database incident,
 * turning a degraded system into an outage. A readiness probe that fails takes the process out of
 * the load balancer rotation and puts it back when the dependency recovers, which is what you
 * want. Contract section 15.6 assumes processes are replaceable and behind an edge, so both
 * signals need to exist and mean different things.
 *
 * AUTHORIZATION NOTE, same as the liveness controller: this route is intentionally
 * unauthenticated and is currently unauthenticated by default rather than by declaration. When
 * the deny by default guard required by contract section 6.2 lands, both health routes must
 * carry an explicit public marker.
 */

import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DATABASE, type Database } from '../database/database.module.js';
import { Public } from '../authorization/route-access.js';

export interface ReadinessResponse {
  status: 'ready';
  checks: { database: 'up' };
}

@Controller('health/ready')
export class ReadinessController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // A probe from a container platform or a load balancer, which carries no session and
  // must not need one. Declared rather than assumed, per section 6.2.
  @Public()
  @Get()
  async check(): Promise<ReadinessResponse> {
    try {
      await this.db.execute(sql`select 1`);
    } catch (error) {
      // The message is deliberately generic. Contract section 2.10 forbids an error from
      // disclosing infrastructure detail, and a connection error can carry a host, a port, a
      // database name and sometimes a role name. The detail belongs in the logs, not the body.
      throw new ServiceUnavailableException({
        status: 'not_ready',
        checks: { database: 'down' },
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }

    return { status: 'ready', checks: { database: 'up' } };
  }
}
