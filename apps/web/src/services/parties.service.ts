/** Customers and suppliers, with their derived balances and aging. */

import type {
  AgingSummary,
  Customer,
  CustomerInvoice,
  Payment,
  SalesOrder,
  Supplier,
} from '@/domain';
import { db, PAYABLES_AGING, RECEIVABLES_AGING } from '@/mocks/db';
import { delay, NotFoundError, queryList, type ListParams, type Paginated } from './client';

export const partiesService = {
  async listCustomers(params: ListParams = {}): Promise<Paginated<Customer>> {
    return delay(
      queryList(db.customers, params, {
        searchFields: (c) => [c.code, c.name, c.email, c.address?.city, c.taxId],
        filterAccessors: {
          active: (c) => String(c.active),
          paymentTerms: (c) => c.paymentTerms.code,
          country: (c) => c.address?.country,
        },
        sortAccessors: {
          code: (c) => c.code,
          name: (c) => c.name,
          balance: (c) => c.balance.amount,
          creditLimit: (c) => c.creditLimit.amount,
        },
        defaultSort: { by: 'name', dir: 'asc' },
      }),
    );
  },

  async getCustomer(id: string): Promise<Customer> {
    const customer = db.customers.find((c) => c.id === id);
    if (!customer) throw new NotFoundError('Customer', id);
    return delay(customer);
  },

  async listSuppliers(params: ListParams = {}): Promise<Paginated<Supplier>> {
    return delay(
      queryList(db.suppliers, params, {
        searchFields: (s) => [s.code, s.name, s.email, s.address?.city, s.taxId],
        filterAccessors: { active: (s) => String(s.active), country: (s) => s.address?.country },
        sortAccessors: {
          code: (s) => s.code,
          name: (s) => s.name,
          balance: (s) => s.balance.amount,
          leadTimeDays: (s) => s.leadTimeDays,
        },
        defaultSort: { by: 'name', dir: 'asc' },
      }),
    );
  },

  async getSupplier(id: string): Promise<Supplier> {
    const supplier = db.suppliers.find((s) => s.id === id);
    if (!supplier) throw new NotFoundError('Supplier', id);
    return delay(supplier);
  },

  /** Everything the customer detail screen needs, in one round trip. */
  async getCustomerActivity(id: string): Promise<{
    orders: SalesOrder[];
    invoices: CustomerInvoice[];
    payments: Payment[];
    aging?: AgingSummary;
  }> {
    return delay({
      orders: db.salesOrders
        .filter((so) => so.customer.id === id)
        .sort((a, b) => b.orderDate.localeCompare(a.orderDate)),
      invoices: db.customerInvoices
        .filter((i) => i.party.id === id)
        .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate)),
      payments: db.payments
        .filter((p) => p.party.id === id)
        .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate)),
      aging: RECEIVABLES_AGING.find((r) => r.partyId === id),
    });
  },

  async getSupplierActivity(id: string) {
    return delay({
      orders: db.purchaseOrders
        .filter((po) => po.supplier.id === id)
        .sort((a, b) => b.orderDate.localeCompare(a.orderDate)),
      bills: db.supplierBills
        .filter((b) => b.party.id === id)
        .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate)),
      payments: db.payments
        .filter((p) => p.party.id === id)
        .sort((a, b) => b.paymentDate.localeCompare(a.paymentDate)),
      aging: PAYABLES_AGING.find((r) => r.partyId === id),
    });
  },

  async receivablesAging(): Promise<AgingSummary[]> {
    return delay(RECEIVABLES_AGING);
  },

  async payablesAging(): Promise<AgingSummary[]> {
    return delay(PAYABLES_AGING);
  },
};
