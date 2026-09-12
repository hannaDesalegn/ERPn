/**
 * Master data, from the backend.
 *
 * WHY THIS SITS BESIDE `inventory.service.ts` RATHER THAN INSIDE IT. That file's
 * `listWarehouses` is read by the stock screens and the purchase order list, and both of those
 * still render fixture documents whose warehouse identifiers exist only in `@/mocks`. Pointing it
 * at the backend would give those screens a filter listing real warehouses that match none of the
 * rows beneath them.
 *
 * So the real read lives here and the fixture one stays where its remaining consumers are. Section
 * 16.1 removes the fixture layer per module as endpoints land, and inventory's has not. When it
 * does, that function goes and its callers come here.
 */

import { request } from './client';

/**
 * A warehouse as a filter or a picker needs it.
 *
 * Exactly what the endpoint returns. There is no city, country or `active` flag as the fixture
 * type carries, because the table holds none of them and inventing them here would be inventing
 * them everywhere.
 */
export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
  status: string;
  /** The default source for sales. A picker opens on it rather than making someone choose. */
  isDefault: boolean;
}

export const masterDataService = {
  /** Every warehouse in the acting company. Unpaged, because a picker reads the whole set. */
  async listWarehouses(): Promise<WarehouseOption[]> {
    return request<WarehouseOption[]>('/warehouses');
  },
};
