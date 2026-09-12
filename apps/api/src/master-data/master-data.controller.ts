/**
 * The master data HTTP surface.
 *
 * Three reads, each as thin as the sales order reads beside them: resolve the company from the
 * session, ask the service, answer. No logic lives here.
 *
 * THE PERMISSIONS ARE THE ONES THAT ALREADY EXIST. `customers:view` for customers and
 * `inventory:view` for products and warehouses, both already in the catalogue and both already
 * held by the sales role template. The note beside `inventory:view` in that template says why a
 * salesperson has it: they need to see stock to promise a delivery date. Nothing was invented to
 * make these routes reachable.
 *
 * TWO PERMISSIONS RATHER THAN ONE, and the split is not arbitrary. A warehouse is inventory
 * configuration and a customer is a party, which is why the catalogue separates them. Folding both
 * behind one capability would let a role that should only see stock read the customer list.
 *
 * THERE IS NO COMPANY PARAMETER ON ANY OF THEM. The scope comes from the session, so a caller has
 * nothing to manipulate. That is the same shape the sales order list takes and for the same
 * reason.
 */

import { Controller, ForbiddenException, Get, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { RequirePermission } from '../authorization/route-access.js';
import { principalOf } from '../http/principal.js';
import { IdentityService } from '../identity/identity.service.js';
import {
  MasterDataService,
  type CustomerView,
  type ProductView,
  type WarehouseView,
} from './master-data.service.js';

@Controller()
export class MasterDataController {
  constructor(
    private readonly identity: IdentityService,
    private readonly masterData: MasterDataService,
  ) {}

  @RequirePermission('customers:view')
  @Get('customers')
  async customers(@Req() request: FastifyRequest): Promise<CustomerView[]> {
    const { context, userId } = await this.acting(request);
    return this.masterData.customers(context, userId);
  }

  @RequirePermission('inventory:view')
  @Get('products')
  async products(@Req() request: FastifyRequest): Promise<ProductView[]> {
    const { context, userId } = await this.acting(request);
    return this.masterData.products(context, userId);
  }

  @RequirePermission('inventory:view')
  @Get('warehouses')
  async warehouses(@Req() request: FastifyRequest): Promise<WarehouseView[]> {
    const { context, userId } = await this.acting(request);
    return this.masterData.warehouses(context, userId);
  }

  /** The company, from the session and only from the session. */
  private async acting(request: FastifyRequest) {
    const principal = principalOf(request);
    const context = await this.identity.currentContext(principal);

    if (!context) throw new ForbiddenException('Forbidden');

    return { context, userId: principal.userId };
  }
}
