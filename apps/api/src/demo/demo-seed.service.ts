/**
 * Building the demo environment on a freshly migrated database.
 *
 * NOT A SECOND PROVISIONING PATH. Every company is created by `CompanyProvisioningService`, so it
 * gets its roles, both numbering sequences, its chart of accounts, its posting account mapping
 * and its first administrator exactly as any other company would. Every further member is given
 * their role through `RoleProvisioningService.assignRole`, acting as that administrator, so the
 * escalation rule of section 6.6 is applied and the assignment is audited. Stock arrives through
 * the stock ledger repository, which writes the movement and moves the balance under the row
 * lock in one call. Nothing below writes a table the application writes some other way.
 *
 * THE ONE THING THE APPLICATION ROLE CANNOT DO IS CREATE A TENANT. It holds SELECT on `tenants`
 * and nothing else, because a tenant is platform administration under section 2.8 and no
 * platform surface exists. So tenant creation is handed in as a `DemoPlatform`, which the entry
 * point implements over the owning role, the same way every integration test creates one. That
 * is the whole of what the owning role is used for.
 *
 * REFUSES RATHER THAN DUPLICATES. The migration runner fails loudly on a state it did not expect
 * rather than guessing, and this follows it: if any demo tenant or demo account already exists,
 * nothing is written and the caller is told how to start again. A seed that tried to be
 * idempotent would have to decide what to do with a demo company someone has been trading in,
 * and there is no right answer to that.
 *
 * NOT ONE TRANSACTION, AND THAT IS STATED RATHER THAN HIDDEN. The tenant rows are written over a
 * different connection from everything else, and company provisioning owns its own transaction.
 * Each company's provisioning, each membership and each company's stock load is atomic on its
 * own. A failure part way leaves a partial environment, which the existence check then refuses
 * to build on top of; the documented recovery is a database reset.
 */

import { Injectable } from '@nestjs/common';

import { PasswordHasher } from '../auth/password-hasher.js';
import { RoleProvisioningService } from '../authorization/role-provisioning.service.js';
import { CompanyProvisioningService } from '../companies/company-provisioning.service.js';
import { systemScope, UnitOfWork } from '../database/index.js';
import { inLockOrder } from '../inventory/lock-order.js';
import {
  DEMO_TENANTS,
  DEMO_USERS,
  demoCompanies,
  demoMembershipId,
  demoUser,
  OPENING_STOCK_DOC_TYPE,
  OPENING_STOCK_REASON,
  type DemoCompany,
  type DemoTenant,
} from './demo-dataset.js';

/** What only the owning role may do, supplied by whoever holds that connection. */
export interface DemoPlatform {
  /** The slugs among those given that already name a tenant. */
  existingTenantSlugs(slugs: readonly string[]): Promise<string[]>;
  createTenant(tenant: { id: string; slug: string; name: string }): Promise<void>;
}

export class DemoAlreadySeededError extends Error {
  constructor(readonly found: string[]) {
    super(
      `Demo data already exists (${found.join(', ')}). Nothing was written. ` +
        'To rebuild the demo environment from scratch: npm run db:reset, npm run db:migrate, npm run db:seed:demo.',
    );
    this.name = 'DemoAlreadySeededError';
  }
}

export interface DemoSeedReport {
  tenants: { slug: string; name: string; companies: string[] }[];
  accounts: { email: string; memberships: { company: string; role: string }[] }[];
  openingStock: { company: string; sku: string; quantity: string; uom: string }[];
}

@Injectable()
export class DemoSeedService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly companies: CompanyProvisioningService,
    private readonly roles: RoleProvisioningService,
    private readonly hasher: PasswordHasher,
  ) {}

  async seed(input: { platform: DemoPlatform; password: string }): Promise<DemoSeedReport> {
    await this.refuseIfPresent(input.platform);

    for (const tenant of DEMO_TENANTS) {
      await input.platform.createTenant({ id: tenant.id, slug: tenant.slug, name: tenant.name });
    }

    await this.createAccounts(input.password);

    for (const { tenant, company } of demoCompanies()) {
      await this.provisionCompany(tenant, company);
      await this.admitMembers(tenant, company);
      await this.loadMasterDataAndOpeningStock(tenant, company);
    }

    return this.report();
  }

  private async refuseIfPresent(platform: DemoPlatform): Promise<void> {
    const tenants = await platform.existingTenantSlugs(DEMO_TENANTS.map((tenant) => tenant.slug));

    // Accounts are global, so a leftover account is found without naming any tenant.
    const accounts = await this.uow.inSystemScope(
      systemScope('tenant-provisioning'),
      async (repositories) => {
        const found: string[] = [];
        for (const user of DEMO_USERS) {
          if (await repositories.users.findByEmail(user.email)) found.push(user.email);
        }
        return found;
      },
    );

    const found = [...tenants.map((slug) => `tenant ${slug}`), ...accounts];
    if (found.length > 0) throw new DemoAlreadySeededError(found);
  }

  /**
   * One account per person, each with its own hash.
   *
   * Hashed one at a time rather than once and copied: a copied hash shares its salt, which would
   * tell anyone reading the table that these accounts share a password.
   */
  private async createAccounts(password: string): Promise<void> {
    const hashed: { id: string; email: string; name: string; passwordHash: string }[] = [];
    for (const user of DEMO_USERS) {
      hashed.push({
        id: user.id,
        email: user.email,
        name: user.name,
        passwordHash: await this.hasher.hash(password),
      });
    }

    await this.uow.inSystemScope(systemScope('tenant-provisioning'), async (repositories) => {
      for (const account of hashed) {
        await repositories.users.create(account);
      }
    });
  }

  private async provisionCompany(tenant: DemoTenant, company: DemoCompany): Promise<void> {
    await this.companies.provision({
      tenantId: tenant.id,
      id: company.id,
      name: company.name,
      legalName: company.legalName,
      baseCurrency: company.baseCurrency,
      administratorUserId: demoUser(company.administrator).id,
    });
  }

  /**
   * Admits each further member, and has the administrator give them their role.
   *
   * The membership is written under the provisioning scope because no endpoint creates one:
   * invitations are not implemented. The role is not. It goes through the
   * same service the administration endpoint calls, as the company's administrator, so a role
   * this dataset tried to hand out beyond the administrator's own authority would be refused
   * here exactly as it would be over HTTP.
   */
  private async admitMembers(tenant: DemoTenant, company: DemoCompany): Promise<void> {
    if (company.members.length === 0) return;

    const administrator = demoUser(company.administrator);
    const scope = systemScope('tenant-provisioning', { tenantId: tenant.id, companyId: company.id });

    const administratorMembershipId = await this.uow.inSystemScope(scope, async (repositories) => {
      const ids = await repositories.memberships.listForCompany();
      const found = ids.find((membership) => membership.userId === administrator.id);
      if (!found) throw new Error(`${company.name} was provisioned without its administrator`);

      for (const member of company.members) {
        await repositories.memberships.create({
          id: demoMembershipId(company.id, member.user),
          userId: demoUser(member.user).id,
        });
      }

      return found.id;
    });

    for (const member of company.members) {
      const outcome = await this.roles.assignRole({
        context: {
          tenantId: tenant.id,
          companyId: company.id,
          membershipId: administratorMembershipId,
        },
        actorUserId: administrator.id,
        membershipId: demoMembershipId(company.id, member.user),
        roleKey: member.role,
      });

      if (outcome.outcome !== 'applied') {
        throw new Error(
          `Assigning ${member.role} to ${member.user} in ${company.name} was refused: ${outcome.outcome}`,
        );
      }
    }
  }

  /**
   * The warehouse, the customers, the products, and the stock on the shelf, in one transaction.
   *
   * One transaction because opening stock names the products and the warehouse by foreign key,
   * and a company holding a catalogue with none of its opening stock is a demo that fails its
   * first confirmation for a reason nobody on screen can see.
   *
   * The audit record is written in the same transaction as the movements, per section 7.1, and
   * says what was loaded and under which source document, so the movements can be traced from
   * the trail and back.
   *
   * A QUANTITY LOAD, NOT A VALUATION. Section 8.3 separates quantity from value, section 8.6's
   * costing does not exist, and the chart holds no inventory account. So opening stock here is
   * the quantity half only, and no journal entry is written for it. Section 9.3's opening
   * balance entry belongs with the inventory accounting that would give it an account to post to.
   */
  private async loadMasterDataAndOpeningStock(
    tenant: DemoTenant,
    company: DemoCompany,
  ): Promise<void> {
    await this.uow.inSystemScope(
      systemScope('tenant-provisioning', { tenantId: tenant.id, companyId: company.id }),
      async (repositories) => {
        await repositories.warehouses.create({
          id: company.warehouse.id,
          code: company.warehouse.code,
          name: company.warehouse.name,
          isDefault: true,
        });

        for (const customer of company.customers) {
          await repositories.customers.create(customer);
        }

        for (const product of company.products) {
          await repositories.products.create({
            id: product.id,
            sku: product.sku,
            name: product.name,
            type: 'stockable',
            stockingUom: product.stockingUom,
            salesPrice: product.salesPrice,
            salesPriceCurrency: company.baseCurrency,
          });
        }

        // Section 10.2's order, even with nobody to race: the rule is stated once and followed
        // everywhere, and a seed is not a reason to be the exception someone copies.
        const loads = inLockOrder(
          company.products.map((product) => ({
            productId: product.id,
            warehouseId: company.warehouse.id,
            quantity: product.openingStock,
          })),
        );

        for (const [index, load] of loads.entries()) {
          await repositories.stockLedger.record({
            id: openingMovementId(company, index),
            productId: load.productId,
            warehouseId: load.warehouseId,
            quantity: load.quantity,
            reason: OPENING_STOCK_REASON,
            sourceDocType: OPENING_STOCK_DOC_TYPE,
            sourceDocId: company.openingStockDocumentId,
          });
        }

        await repositories.audit.append({
          action: 'opening_stock_recorded',
          entityType: 'company',
          entityId: company.id,
          summary: `Recorded opening stock for ${company.products.length} products`,
          changes: {
            sourceDocType: OPENING_STOCK_DOC_TYPE,
            sourceDocId: company.openingStockDocumentId,
            warehouseId: company.warehouse.id,
            lines: company.products.map((product) => ({
              productId: product.id,
              sku: product.sku,
              quantity: product.openingStock,
            })),
          },
        });
      },
    );
  }

  private report(): DemoSeedReport {
    const companies = demoCompanies();

    return {
      tenants: DEMO_TENANTS.map((tenant) => ({
        slug: tenant.slug,
        name: tenant.name,
        companies: tenant.companies.map((company) => company.name),
      })),
      accounts: DEMO_USERS.map((user) => ({
        email: user.email,
        memberships: companies.flatMap(({ company }) => {
          if (company.administrator === user.key) {
            return [{ company: company.name, role: 'administrator' }];
          }
          return company.members
            .filter((member) => member.user === user.key)
            .map((member) => ({ company: company.name, role: member.role }));
        }),
      })),
      openingStock: companies.flatMap(({ company }) =>
        company.products.map((product) => ({
          company: company.name,
          sku: product.sku,
          quantity: product.openingStock,
          uom: product.stockingUom,
        })),
      ),
    };
  }
}

/** Deterministic, like the rest of the dataset: the company's opening document, then a line. */
function openingMovementId(company: DemoCompany, index: number): string {
  const companyPart = company.openingStockDocumentId.slice(-4);
  return `de000009-0000-4000-8000-${companyPart}${(index + 1).toString(16).padStart(8, '0')}`;
}
