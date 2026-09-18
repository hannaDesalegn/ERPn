/**
 * Liveness endpoint.
 *
 * Deliberately shallow. It answers "is this process up and serving HTTP" and nothing else.
 * It does not check the database, because a liveness probe that fails when a dependency is down
 * causes an orchestrator to restart a healthy process and make an outage worse. The readiness
 * endpoint, `/health/ready`, is the one that checks dependencies.
 *
 * AUTHORIZATION NOTE. This route is intentionally unauthenticated, and says so with an explicit
 * public declaration, as architecture section 6.2 and criterion 7 require of every route.
 */

import { Controller, Get } from '@nestjs/common';
import { Public } from '../authorization/route-access.js';

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
}

@Controller('health')
export class HealthController {
  // A probe from a container platform or a load balancer, which carries no session and
  // must not need one. Declared rather than assumed, per section 6.2.
  @Public()
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
