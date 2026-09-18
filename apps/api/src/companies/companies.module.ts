/**
 * Companies.
 *
 * Section 15.7 makes a module a business boundary rather than a folder. This one owns bringing a
 * company into existence with the configuration it needs.
 *
 * No controller. Creating a company is platform administration, which section 2.8 keeps
 * deliberately separate from company administration, and no platform surface exists.
 */

import { Module } from '@nestjs/common';

import { CompanyProvisioningService } from './company-provisioning.service.js';

@Module({
  providers: [CompanyProvisioningService],
  exports: [CompanyProvisioningService],
})
export class CompaniesModule {}
