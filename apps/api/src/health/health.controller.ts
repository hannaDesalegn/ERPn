/**
 * Liveness endpoint.
 *
 * Deliberately shallow. It answers "is this process up and serving HTTP" and nothing else.
 * It does not check the database, because this increment has no database, and because a
 * liveness probe that fails when a dependency is down causes an orchestrator to restart a
 * healthy process and make an outage worse. A separate readiness endpoint that does check
 * dependencies arrives with the database increment.
 *
 * AUTHORIZATION NOTE. This route is intentionally unauthenticated, and it is currently
 * unauthenticated by default rather than by declaration, because the deny by default guard
 * required by contract section 6.2 and slice 1 criterion 7 does not exist yet. When that
 * guard lands, this route must carry an explicit public marker. It is the only route in the
 * application that should ever need one.
 */

import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  uptimeSeconds: number;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }
}
