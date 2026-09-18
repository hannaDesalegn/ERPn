/**
 * The order balance rows are locked in, stated once.
 *
 * Architecture section 10.2 requires a lock acquisition order to be documented and followed, so that
 * deadlocks are designed out rather than retried around. This file is that order. Every operation
 * that locks more than one balance row sorts its work through `byBalanceKey` first, and none of
 * them decides the order for itself.
 *
 * THE ORDER IS THE KEY ITSELF: product, then warehouse. A balance row is identified by that pair
 * within a company, so sorting by it gives every transaction in the system the same sequence over
 * the same rows, which is the property that makes a deadlock unreachable rather than unlikely.
 *
 * WHAT IT IS DELIBERATELY NOT. It is not line order, and that was the bug this file exists to
 * close. Line order looks like an order and is one only within a single document: two orders
 * listing the same two products in opposite line order acquire the same two locks in opposite
 * sequences, which is the textbook deadlock. It is not the order the database returned either,
 * because a query plan is free to change and an ordering nobody stated is an ordering nobody
 * keeps.
 *
 * THE COMPARISON IS ON THE IDENTIFIERS, not on a name or a code. Identifiers are stable for the
 * life of a row; a product can be renamed between two transactions, and two transactions sorting
 * by a value that changed under them would disagree about the order and deadlock exactly as if
 * neither had sorted.
 */

/** The pair that identifies a balance row within a company. */
export interface BalanceKey {
  productId: string;
  warehouseId: string;
}

/**
 * Total order over balance keys.
 *
 * Total rather than partial: two different rows never compare equal, because the pair is unique
 * within a company. A comparator that returned zero for distinct rows would leave their relative
 * order to the sort's stability, which is the same as not having stated an order.
 */
export function byBalanceKey(a: BalanceKey, b: BalanceKey): number {
  if (a.productId !== b.productId) return a.productId < b.productId ? -1 : 1;
  if (a.warehouseId !== b.warehouseId) return a.warehouseId < b.warehouseId ? -1 : 1;
  return 0;
}

/**
 * The same items, in the order their balance rows must be locked in.
 *
 * Returns a new array. Sorting the caller's would reorder a list that usually means something
 * else, and the lines of a document mean their line numbers.
 */
export function inLockOrder<T extends BalanceKey>(items: readonly T[]): T[] {
  return [...items].sort(byBalanceKey);
}

/**
 * THE SECOND CONTENDED ROW, AND WHY IT IS STATED HERE RATHER THAN DECIDED PER CALLER.
 *
 * Section 10.2 lists the rows many transactions contend for and requires an acquisition order
 * documented and followed. Sales order lines are a second such row, and they arrived with invoice
 * posting: two invoices raised from one order compete for the same `invoiced_quantity`, and each
 * posting writes several lines in one transaction. Two postings touching an overlapping set in
 * opposite sequences would deadlock exactly as two confirmations over balance rows once did.
 *
 * It is not an amendment to 10.2. That clause requires the order to exist and be followed; this
 * is a second order for a second row, stated in the one file that states them, so no caller
 * decides its own.
 *
 * WHY THE IDENTIFIER AND NOT THE LINE NUMBER. A line number orders the lines of one document and
 * nothing across two, which is the mistake `byBalanceKey` exists to prevent. An invoice bills
 * lines of several orders, so line numbers collide across them and say nothing about sequence.
 * The identifier is unique, stable for the life of the row, and gives every transaction in the
 * system the same sequence over the same rows.
 *
 * WHAT THIS DOES NOT ORDER is the two categories against each other. Nothing locks a balance row
 * and a sales order line in one transaction today: confirmation takes balance rows and posting
 * takes order lines, and posting deliberately moves no stock. The day an operation needs both,
 * the order between the categories has to be stated here before it is written.
 */
export interface SalesOrderLineKey {
  id: string;
}

/** Total order over sales order line rows. Distinct rows never compare equal. */
export function bySalesOrderLineId(a: SalesOrderLineKey, b: SalesOrderLineKey): number {
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** The same items, in the order their sales order line rows must be locked in. */
export function inSalesOrderLineLockOrder<T extends SalesOrderLineKey>(items: readonly T[]): T[] {
  return [...items].sort(bySalesOrderLineId);
}
