/**
 * Reading the master data a sales order points at.
 *
 * THREE LISTS AND NOTHING ELSE. Customers, products and warehouses, each as a picker needs them.
 * There is no create, no edit and no archive here: section 2.9 makes master data something a
 * company administers, and those screens are their own work. What these exist for is that a sales
 * order names a customer, a warehouse and a product, and until now nothing could offer a real one.
 *
 * WHY ONE MODULE FOR THREE THINGS. Section 15.7 makes a module a business boundary rather than a
 * folder, and customers, products and warehouses are eventually three: parties, the catalogue, and
 * organisation configuration. They share a file here for the same reason migration 0006 put them
 * in one, which said it plainly: each is a handful of columns, and the moment any of them grows
 * its own behaviour it gets its own module.
 *
 * WHAT IS NOT RETURNED. No tenant or company, because both are implicit in the scope that fetched
 * the rows and repeating them would invite a caller to think they were parameters. No version,
 * because nothing here edits. No `allowNegativeStock`, because that is a policy the server reads
 * when it moves stock, not something a picker shows. No sales price, because section 3.3 makes the
 * price the server's to apply and a form that displayed one would be a form somebody expected to
 * send back.
 */

import { Injectable } from '@nestjs/common';

import { actorScope, UnitOfWork } from '../database/index.js';
import type { ScopedRepositories } from '../database/index.js';
import type { CompanyContext } from '../identity/identity.service.js';

/** The three repositories these reads use, and no others. */
type MasterDataRepositories = Pick<ScopedRepositories, 'customers' | 'products' | 'warehouses'>;

/** A party the company sells to, as a picker needs it. */
export interface CustomerView {
  id: string;
  code: string;
  name: string;
  /** Archived records are still returned. A picker hides them; history still names them. */
  status: string;
}

export interface ProductView {
  id: string;
  sku: string;
  name: string;
  /** Only a stockable product participates in inventory, per section 8.4's note in 0006. */
  type: string;
  /** The canonical unit the ledger records, which is the unit a quantity is entered in. */
  stockingUom: string;
  status: string;
}

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  status: string;
  /** The default source for sales. A picker opens on it rather than making someone choose. */
  isDefault: boolean;
}

@Injectable()
export class MasterDataService {
  constructor(private readonly uow: UnitOfWork) {}

  /**
   * Every customer in the acting company.
   *
   * Unpaged, because a picker reads the whole set and this is a company's customer list rather
   * than a document history. If one ever grows past what a select can hold, that is a search
   * endpoint rather than a page, and it is a different thing to build.
   */
  async customers(context: CompanyContext, actorUserId: string): Promise<CustomerView[]> {
    const rows = await this.read(context, actorUserId, (repos) => repos.customers.listForCompany());

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
    }));
  }

  async products(context: CompanyContext, actorUserId: string): Promise<ProductView[]> {
    const rows = await this.read(context, actorUserId, (repos) => repos.products.listForCompany());

    return rows.map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      type: row.type,
      stockingUom: row.stockingUom,
      status: row.status,
    }));
  }

  async warehouses(context: CompanyContext, actorUserId: string): Promise<WarehouseView[]> {
    const rows = await this.read(context, actorUserId, (repos) =>
      repos.warehouses.listForCompany(),
    );

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      isDefault: row.isDefault,
    }));
  }

  /**
   * One scoped read, written once.
   *
   * Every list above is the same shape: open a transaction under the acting scope, ask the
   * repository for this company's rows. The scope predicate is inside those repository methods, so
   * another company's records are not filtered out afterwards; they are not among the rows the
   * query can return.
   */
  private read<T>(
    context: CompanyContext,
    actorUserId: string,
    query: (repos: MasterDataRepositories) => Promise<T>,
  ): Promise<T> {
    return this.uow.inActorScope(
      actorScope({
        tenantId: context.tenantId,
        companyId: context.companyId,
        userId: actorUserId,
      }),
      query,
    );
  }
}
