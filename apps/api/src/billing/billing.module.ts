/**
 * Billing.
 *
 * Section 15.7 makes a module a business boundary rather than a folder. This one owns the customer
 * invoice: creating a draft from confirmed sales orders, editing one, and reading one.
 *
 * WHAT IT DOES NOT OWN YET. Posting, which section 12.2 makes one transaction writing the status
 * change, the journal entry and its lines, the audit record and the document number. That is the
 * next increment, and nothing here does any part of it.
 *
 * THE CONTROLLER HOLDS NO LOGIC, only the translation between HTTP and the operations beneath it,
 * each of which takes a transaction's repositories and is callable without any of this.
 */

import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { CustomerInvoiceController } from './customer-invoice.controller.js';
import { CustomerInvoiceService } from './customer-invoice.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [CustomerInvoiceController],
  providers: [CustomerInvoiceService],
  exports: [CustomerInvoiceService],
})
export class BillingModule {}
