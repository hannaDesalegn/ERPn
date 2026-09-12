/**
 * Sales.
 *
 * Section 15.7 makes a module a business boundary rather than a folder. This one owns the sales
 * order, and at present owns exactly one operation on it: creating a draft.
 *
 * ONE ROUTE, AND IT IS CONFIRMATION. Draft creation is still not exposed: section 12.2's
 * confirming transaction is what the slice exists to prove, and an endpoint offering draft
 * creation alone would be a surface promising an order flow that stops halfway. The controller
 * holds no logic, only the translation between HTTP and the operations beneath it.
 */

import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { SalesOrderController } from './sales-order.controller.js';
import { SalesOrderService } from './sales-order.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [SalesOrderController],
  providers: [SalesOrderService],
  exports: [SalesOrderService],
})
export class SalesModule {}
