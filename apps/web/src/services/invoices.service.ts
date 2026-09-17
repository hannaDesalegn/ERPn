/**
 * Customer invoices, from the backend.
 *
 * Separate from `finance.service.ts`, which still answers the invoice list and every other finance
 * screen from fixtures. Keeping the real calls in their own file keeps the boundary visible: a
 * screen importing from here reads the server, and nothing here reaches `@/mocks`.
 *
 * WHAT THE SERVER OWNS. The number, the status, every figure and every line. They arrive in the
 * responses below and are never worked out here, per contract sections 3.3 and 10.4.
 */

import type { ID, ISODate, Money } from '@/domain';
import { request } from './client';
import { toMoney } from './sales.service';

/** An invoice as the backend holds it. Figures are decimal strings, per section 4.3. */
interface CustomerInvoiceResponse {
  id: string;
  docNumber: string | null;
  status: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  customer: { id: string; name: string; taxRegistrationNumber: string | null };
  subtotal: string;
  taxTotal: string;
  total: string;
  version: number;
  salesOrders: { id: string; docNumber: string | null }[];
  lines: {
    id: string;
    lineNumber: number;
    sourceSalesOrderId: string;
    sourceSalesOrderLineId: string;
    productId: string;
    productSku: string;
    productName: string;
    quantity: string;
    unitPrice: string;
    discountPercent: string;
    taxRatePercent: string;
    lineSubtotal: string;
    lineTax: string;
    lineTotal: string;
  }[];
}

/**
 * The two states the backend's invoice can be in today.
 *
 * Not the fixture `InvoiceStatus`, which carries payment states the backend has no source for.
 */
export type CustomerInvoiceStatus = 'draft' | 'posted';

/**
 * What the invoice screen works with.
 *
 * Deliberately not the fixture `CustomerInvoice`. That type carries a paid amount, a balance due,
 * who posted it, a journal entry number and a links array, and the invoice response has none of
 * them. Declaring them and filling them with zeroes would put claims in the type nothing stands
 * behind.
 */
export interface CustomerInvoiceDetail {
  id: ID;
  /** Null while a draft. Allocated by the posting transaction. */
  docNumber: string | null;
  status: CustomerInvoiceStatus;
  invoiceDate: ISODate;
  dueDate: ISODate | null;
  currency: Money['currency'];
  customer: { id: ID; name: string; taxRegistrationNumber: string | null };
  subtotal: Money;
  taxTotal: Money;
  total: Money;
  version: number;
  salesOrders: { id: ID; docNumber: string | null }[];
  lines: CustomerInvoiceDetailLine[];
}

export interface CustomerInvoiceDetailLine {
  id: ID;
  lineNumber: number;
  sourceSalesOrderId: ID;
  productId: ID;
  productSku: string;
  productName: string;
  quantity: number;
  unitPrice: Money;
  discountPercent: number;
  taxRatePercent: number;
  lineSubtotal: Money;
  lineTax: Money;
  lineTotal: Money;
}

function toDetail(response: CustomerInvoiceResponse): CustomerInvoiceDetail {
  const currency = response.currency;

  return {
    id: response.id,
    docNumber: response.docNumber,
    status: response.status as CustomerInvoiceStatus,
    invoiceDate: response.invoiceDate,
    dueDate: response.dueDate,
    currency: currency as Money['currency'],
    customer: response.customer,
    subtotal: toMoney(response.subtotal, currency),
    taxTotal: toMoney(response.taxTotal, currency),
    total: toMoney(response.total, currency),
    version: response.version,
    salesOrders: response.salesOrders,
    lines: response.lines.map((line) => ({
      id: line.id,
      lineNumber: line.lineNumber,
      sourceSalesOrderId: line.sourceSalesOrderId,
      productId: line.productId,
      productSku: line.productSku,
      productName: line.productName,
      quantity: Number(line.quantity),
      unitPrice: toMoney(line.unitPrice, currency),
      discountPercent: Number(line.discountPercent),
      taxRatePercent: Number(line.taxRatePercent),
      lineSubtotal: toMoney(line.lineSubtotal, currency),
      lineTax: toMoney(line.lineTax, currency),
      lineTotal: toMoney(line.lineTotal, currency),
    })),
  };
}

export const invoicesService = {
  /**
   * One customer invoice.
   *
   * Another company's invoice answers 404, the same as one that does not exist, per section 6.1.
   */
  async getInvoice(id: string): Promise<CustomerInvoiceDetail> {
    return toDetail(await request<CustomerInvoiceResponse>(`/customer-invoices/${id}`));
  },
};
