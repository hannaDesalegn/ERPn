/** Invoices, bills, payments, and the general ledger. */

import type {
  Account,
  CustomerInvoice,
  JournalEntry,
  Payment,
  SupplierBill,
  TrialBalanceRow,
} from '@/domain';
import { db } from '@/mocks/db';
import { delay, NotFoundError, queryList, type ListParams, type Paginated } from './client';

export const financeService = {
  // ---- Customer invoices --------------------------------------------------
  async listCustomerInvoices(params: ListParams = {}): Promise<Paginated<CustomerInvoice>> {
    const config = {
      searchFields: (i: CustomerInvoice) => [i.docNumber, i.party.name, ...i.salesOrderNumbers],
      filterAccessors: {
        status: (i: CustomerInvoice) => i.status,
        customerId: (i: CustomerInvoice) => i.party.id,
      },
      sortAccessors: {
        docNumber: (i: CustomerInvoice) => i.docNumber,
        invoiceDate: (i: CustomerInvoice) => i.invoiceDate,
        dueDate: (i: CustomerInvoice) => i.dueDate,
        total: (i: CustomerInvoice) => i.total.amount,
        balanceDue: (i: CustomerInvoice) => i.balanceDue.amount,
        party: (i: CustomerInvoice) => i.party.name,
      },
      defaultSort: { by: 'invoiceDate', dir: 'desc' as const },
    };
    const result = queryList(db.customerInvoices, params, config);
    const all = queryList(db.customerInvoices, { ...params, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, config).rows;
    return delay({
      ...result,
      totals: {
        value: all.reduce((a, i) => a + i.total.amount, 0),
        outstanding: all.reduce((a, i) => a + i.balanceDue.amount, 0),
      },
    });
  },

  async getCustomerInvoice(id: string): Promise<CustomerInvoice> {
    const invoice = db.customerInvoices.find((i) => i.id === id);
    if (!invoice) throw new NotFoundError('Invoice', id);
    return delay(invoice);
  },

  // ---- Supplier bills -----------------------------------------------------
  async listSupplierBills(params: ListParams = {}): Promise<Paginated<SupplierBill>> {
    const config = {
      searchFields: (b: SupplierBill) => [b.docNumber, b.party.name, b.supplierReference, ...b.purchaseOrderNumbers],
      filterAccessors: {
        status: (b: SupplierBill) => b.status,
        matchStatus: (b: SupplierBill) => b.matchStatus,
        supplierId: (b: SupplierBill) => b.party.id,
      },
      sortAccessors: {
        docNumber: (b: SupplierBill) => b.docNumber,
        invoiceDate: (b: SupplierBill) => b.invoiceDate,
        dueDate: (b: SupplierBill) => b.dueDate,
        total: (b: SupplierBill) => b.total.amount,
        balanceDue: (b: SupplierBill) => b.balanceDue.amount,
      },
      defaultSort: { by: 'invoiceDate', dir: 'desc' as const },
    };
    const result = queryList(db.supplierBills, params, config);
    const all = queryList(db.supplierBills, { ...params, page: 1, pageSize: Number.MAX_SAFE_INTEGER }, config).rows;
    return delay({
      ...result,
      totals: {
        value: all.reduce((a, b) => a + b.total.amount, 0),
        outstanding: all.reduce((a, b) => a + b.balanceDue.amount, 0),
      },
    });
  },

  async getSupplierBill(id: string): Promise<SupplierBill> {
    const bill = db.supplierBills.find((b) => b.id === id);
    if (!bill) throw new NotFoundError('Supplier bill', id);
    return delay(bill);
  },

  // ---- Payments -----------------------------------------------------------
  async listPayments(params: ListParams = {}): Promise<Paginated<Payment>> {
    return delay(
      queryList(db.payments, params, {
        searchFields: (p) => [p.docNumber, p.party.name, p.reference, p.cashAccountName],
        filterAccessors: {
          direction: (p) => p.direction,
          method: (p) => p.method,
          status: (p) => p.status,
          partyId: (p) => p.party.id,
        },
        sortAccessors: {
          docNumber: (p) => p.docNumber,
          paymentDate: (p) => p.paymentDate,
          amount: (p) => p.amount.amount,
        },
        defaultSort: { by: 'paymentDate', dir: 'desc' },
      }),
    );
  },

  async getPayment(id: string): Promise<Payment> {
    const payment = db.payments.find((p) => p.id === id);
    if (!payment) throw new NotFoundError('Payment', id);
    return delay(payment);
  },

  // ---- Accounting ---------------------------------------------------------
  async chartOfAccounts(): Promise<Account[]> {
    return delay([...db.accounts].sort((a, b) => a.code.localeCompare(b.code)));
  },

  async listJournalEntries(params: ListParams = {}): Promise<Paginated<JournalEntry>> {
    return delay(
      queryList(db.journalEntries, params, {
        searchFields: (j) => [j.docNumber, j.memo, j.sourceDocument?.docNumber],
        filterAccessors: { origin: (j) => j.origin, status: (j) => j.status },
        sortAccessors: {
          docNumber: (j) => j.docNumber,
          entryDate: (j) => j.entryDate,
          amount: (j) => j.totalDebit.amount,
        },
        defaultSort: { by: 'entryDate', dir: 'desc' },
      }),
    );
  },

  async getJournalEntry(id: string): Promise<JournalEntry> {
    const entry = db.journalEntries.find((j) => j.id === id);
    if (!entry) throw new NotFoundError('Journal entry', id);
    return delay(entry);
  },

  /**
   * TRIAL BALANCE — every account's total debits and credits.
   * Built from journal lines, which is the only correct way: reading an account's
   * stored `balance` field would hide exactly the discrepancy this report exists
   * to catch.
   */
  async trialBalance(): Promise<{ rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean }> {
    const byAccount = new Map<string, TrialBalanceRow>();

    for (const entry of db.journalEntries) {
      if (entry.status !== 'posted') continue;
      for (const line of entry.lines) {
        const account = db.accounts.find((a) => a.id === line.accountId);
        if (!account) continue;
        const row = byAccount.get(line.accountId) ?? {
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          accountType: account.type,
          debit: { amount: 0, currency: 'USD' as const },
          credit: { amount: 0, currency: 'USD' as const },
        };
        row.debit = { amount: row.debit.amount + line.debit.amount, currency: 'USD' };
        row.credit = { amount: row.credit.amount + line.credit.amount, currency: 'USD' };
        byAccount.set(line.accountId, row);
      }
    }

    const rows = [...byAccount.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    const totalDebit = rows.reduce((a, r) => a + r.debit.amount, 0);
    const totalCredit = rows.reduce((a, r) => a + r.credit.amount, 0);

    return delay({ rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit });
  },

  /** All journal lines touching one account, with a running balance. */
  async generalLedger(accountId: string) {
    const account = db.accounts.find((a) => a.id === accountId);
    if (!account) throw new NotFoundError('Account', accountId);

    const entries = [...db.journalEntries]
      .filter((j) => j.status === 'posted' && j.lines.some((l) => l.accountId === accountId))
      .sort((a, b) => a.entryDate.localeCompare(b.entryDate));

    let running = 0;
    const rows = entries.flatMap((entry) =>
      entry.lines
        .filter((l) => l.accountId === accountId)
        .map((line) => {
          const delta =
            account.normalBalance === 'debit'
              ? line.debit.amount - line.credit.amount
              : line.credit.amount - line.debit.amount;
          running += delta;
          return {
            id: line.id,
            date: entry.entryDate,
            journalEntryId: entry.id,
            journalEntryNumber: entry.docNumber,
            memo: entry.memo,
            partyName: line.partyName,
            debit: line.debit,
            credit: line.credit,
            runningBalance: { amount: running, currency: 'USD' as const },
          };
        }),
    );

    return delay({ account, rows: rows.reverse() });
  },
};
