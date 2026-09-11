/**
 * Companies.
 *
 * Section 15.7 makes a module a business boundary rather than a folder. This one owns bringing a
 * company into existence, which until now was a bare repository insert with no owner at all.
 *
 * No controller. Creating a company is platform administration, which section 2.8 keeps
 * deliberately separate from company administration, and the platform surface does not exist
 * yet. An endpoint here before that distinction is built would be the wrong one.
 */

import { Module } from '@nestjs/common';

import { CompanyProvisioningService } from './company-provisioning.service.js';

@Module({
  providers: [CompanyProvisioningService],
  exports: [CompanyProvisioningService],
})
export class CompaniesModule {}
