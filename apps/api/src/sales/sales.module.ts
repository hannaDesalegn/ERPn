/**
 * Sales.
 *
 * Section 15.7 makes a module a business boundary rather than a folder. This one owns the sales
 * order and the operations on it: creating a draft, editing one, reading one, confirming, and
 * cancelling under section 12.3.
 *
 * THE CONTROLLER HOLDS NO LOGIC, only the translation between HTTP and the operations beneath it,
 * each of which takes a transaction's repositories and is callable without any of this.
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
