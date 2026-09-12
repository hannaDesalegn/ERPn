/**
 * Master data: customers, products and warehouses.
 *
 * One module for three things, for the reason migration 0006 gave when it put them in one file.
 * Each is a handful of columns and a list, and the moment any of them grows its own behaviour it
 * becomes its own module under section 15.7.
 *
 * Reads only. Section 2.9 makes administering master data a company's own screens, which are not
 * this. These exist because a sales order names a customer, a warehouse and a product, and nothing
 * could offer a real one until now.
 */

import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { MasterDataController } from './master-data.controller.js';
import { MasterDataService } from './master-data.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [MasterDataController],
  providers: [MasterDataService],
  exports: [MasterDataService],
})
export class MasterDataModule {}
