/**
 * Sales.
 *
 * Section 15.7 makes a module a business boundary rather than a folder. This one owns the sales
 * order, and at present owns exactly one operation on it: creating a draft.
 *
 * No controller. Section 12.2's confirming transaction, the number allocation of 10.4, the
 * reservation of 8.5, the idempotency of section 11 and the audit record of 7.1 are all still
 * ahead, and an endpoint that offered draft creation without them would be a surface promising
 * an order flow that does not exist.
 */

import { Module } from '@nestjs/common';

import { SalesOrderService } from './sales-order.service.js';

@Module({
  providers: [SalesOrderService],
  exports: [SalesOrderService],
})
export class SalesModule {}
