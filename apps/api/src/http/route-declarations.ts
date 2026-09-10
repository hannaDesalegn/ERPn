/**
 * Refuses to start with a route that declares no access rule.
 *
 * Contract section 6.2 and criterion 7: every registered route declares the permission it
 * requires, and a route that declares none fails to register. The guard already denies such a
 * route at request time, so nothing is exposed either way. The reason to fail the boot as well
 * is that a silent denial is discovered by a user hitting a 403 on a feature that was supposed
 * to work, and a failed boot is discovered by the person who just wrote the route.
 *
 * HOW ROUTES ARE FOUND. Through Nest's own discovery rather than the HTTP server's route table.
 * Two reasons. The metadata lives on the controller method, which is what discovery walks, so
 * this reads the same thing the guard reads rather than a parallel view that could disagree.
 * And it names the offender as `ClassName.methodName`, which is where the missing decorator has
 * to go, instead of as a path and verb that someone then has to go and find.
 */

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants.js';

import { ROUTE_ACCESS, type RouteAccess } from '../authorization/route-access.js';

export interface DeclaredRoute {
  controller: string;
  handler: string;
  access: RouteAccess;
}

@Injectable()
export class RouteDeclarationAudit implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteDeclarationAudit.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    const { declared, undeclared } = this.inspect();

    if (undeclared.length > 0) {
      const detail = undeclared.join(', ');
      this.logger.error(`Routes with no access declaration: ${detail}`);
      throw new Error(
        `Every route must declare its access with @Public, @AuthenticatedOnly or @RequirePermission. Missing on: ${detail}`,
      );
    }

    this.logger.log(`${declared.length} routes, each with a declared access rule`);
  }

  /**
   * Every controller handler, with its declaration or without one.
   *
   * Public so the matrix test can build itself from the same list the guard enforces, rather
   * than from a table someone maintains by hand beside it. A matrix that is written out
   * separately agrees with the code until the day a route is added.
   */
  inspect(): { declared: DeclaredRoute[]; undeclared: string[] } {
    const declared: DeclaredRoute[] = [];
    const undeclared: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as object | undefined;
      if (!instance) continue;

      const prototype = Object.getPrototypeOf(instance) as object;
      const controller = wrapper.metatype?.name ?? 'UnknownController';

      for (const method of this.scanner.getAllMethodNames(prototype)) {
        const handler = (instance as Record<string, unknown>)[method];
        if (typeof handler !== 'function') continue;

        // A method is a route only if a routing decorator gave it a path. Helpers and
        // constructors on the same class are not routes and must not be demanded to declare.
        if (Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;

        const access = this.reflector.getAllAndOverride<RouteAccess | undefined>(ROUTE_ACCESS, [
          handler as (...args: unknown[]) => unknown,
          wrapper.metatype ?? Object,
        ]);

        if (access) {
          declared.push({ controller, handler: method, access });
        } else {
          undeclared.push(`${controller}.${method}`);
        }
      }
    }

    return { declared, undeclared };
  }
}
