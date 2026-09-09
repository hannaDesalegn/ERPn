/** Purchase cycle reads. */

import type { GoodsReceipt, PurchaseOrder } from '@/domain';
import { db } from '@/mocks/db';
import { delay, NotFoundError, queryList, type ListParams, type Paginated } from './client';

export const purchasingService = {
  async listOrders(params: ListParams = {}): Promise<Paginated<PurchaseOrder>> {
    const config = {
      searchFields: (po: PurchaseOrder) => [po.docNumber, po.supplier.name, po.warehouseName, po.requestedBy.name],
      filterAccessors: {
        status: (po: PurchaseOrder) => po.status,
        warehouseId: (po: PurchaseOrder) => po.warehouseId,
        supplierId: (po: PurchaseOrder) => po.supplier.id,
      },
      sortAccessors: {
        docNumber: (po: PurchaseOrder) => po.docNumber,
        orderDate: (po: PurchaseOrder) => po.orderDate,
        supplier: (po: PurchaseOrder) => po.supplier.name,
        total: (po: PurchaseOrder) => po.total.amount,
        status: (po: PurchaseOrder) => po.status,
      },
      defaultSort: { by: 'orderDate', dir: 'desc' as const },
    };

    const result = queryList(db.purchaseOrders, params, config);
    const filteredValue = queryList(
      db.purchaseOrders,
      { ...params, page: 1, pageSize: Number.MAX_SAFE_INTEGER },
      config,
    ).rows.reduce((acc, po) => acc + po.total.amount, 0);

    return delay({ ...result, totals: { value: filteredValue } });
  },

  async getOrder(id: string): Promise<PurchaseOrder> {
    const order = db.purchaseOrders.find((po) => po.id === id);
    if (!order) throw new NotFoundError('Purchase order', id);
    return delay(order);
  },

  async listReceipts(params: ListParams = {}): Promise<Paginated<GoodsReceipt>> {
    return delay(
      queryList(db.goodsReceipts, params, {
        searchFields: (gr) => [gr.docNumber, gr.supplier.name, gr.purchaseOrderNumber, gr.supplierDeliveryNote],
        filterAccessors: { status: (gr) => gr.status, warehouseId: (gr) => gr.warehouseId },
        sortAccessors: { docNumber: (gr) => gr.docNumber, receivedDate: (gr) => gr.receivedDate },
        defaultSort: { by: 'receivedDate', dir: 'desc' },
      }),
    );
  },

  async getReceipt(id: string): Promise<GoodsReceipt> {
    const receipt = db.goodsReceipts.find((gr) => gr.id === id);
    if (!receipt) throw new NotFoundError('Goods receipt', id);
    return delay(receipt);
  },

  async pendingApprovals(): Promise<PurchaseOrder[]> {
    return delay(db.purchaseOrders.filter((po) => po.status === 'pending_approval'));
  },

  async recentOrders(limit = 6): Promise<PurchaseOrder[]> {
    return delay(
      [...db.purchaseOrders]
        .filter((po) => po.status !== 'draft')
        .sort((a, b) => b.orderDate.localeCompare(a.orderDate))
        .slice(0, limit),
    );
  },
};
