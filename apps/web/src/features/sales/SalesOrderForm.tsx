/**
 * The sales order draft form, shared by creating one and editing one.
 *
 * IT SPEAKS TO NOTHING. It reads the master data its pickers need and otherwise only reports what
 * was entered. Creating and editing differ in where that goes, which is the page's business, so
 * the mutation, the idempotency key and the navigation all live with the caller.
 *
 * THE BOUNDARY BETWEEN WHAT A PERSON CHOOSES AND WHAT THE SERVER DECIDES is drawn here.
 *
 * WHAT A PERSON CHOOSES: a customer, a warehouse, the dates, and for each line a product, a
 * quantity and a discount they negotiated. That is the whole of it.
 *
 * WHAT THE SERVER DECIDES, and what this form therefore has no field for: the price, the tax rate,
 * every total, the product and customer names copied onto the document, the status, the version
 * and the document number. Section 3.3 makes all of that the server's, recomputed from its own
 * master data, and the request type has nowhere to put any of it. There is deliberately no running
 * total on this screen: showing one would mean pricing the order here, and a figure computed in
 * two places is a figure that will eventually disagree with itself.
 *
 * NO REPRESENTATIVE FIELD. The creation contract makes it optional, and the only endpoint that
 * lists people needs `admin:users` and returns no names, so there is no honest way to offer a
 * picker. Left out rather than invented.
 *
 * QUANTITIES AND DISCOUNTS ARE STRINGS ALL THE WAY DOWN. Section 4.3 keeps them exact to six
 * decimal places, and a number input that handed back a double would have lost the sixth before
 * this saw it.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api, queryKeys } from '@/services';
import type { NewSalesOrderInput } from '@/services/sales.service';
import { Button, Card, CardHeader, Icon, PageHeader, Select } from '@/components/ui';
import { refusalText } from './refusalText';

/** One line as the form holds it, before anything is sent. */
interface LineDraft {
  /** Local only, so React can key the rows. Never sent. */
  key: string;
  productId: string;
  quantity: string;
  discountPercent: string;
}

/** Local row identity, so React can key the rows. Never sent and never seen. */
let rowCounter = 0;

const emptyLine = (): LineDraft => ({
  key: `line-${(rowCounter += 1)}`,
  productId: '',
  quantity: '',
  discountPercent: '',
});

/**
 * A labelled input with room for what is wrong with it.
 *
 * Local rather than added to the shared `Field`, which is a read only display component built
 * from a description list for the detail screens and truncates its content. Widening that to
 * serve forms would change every document screen to suit this one.
 */
function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      {label && (
        <label className="text-2xs font-medium tracking-wide text-muted uppercase">{label}</label>
      )}
      <div className="mt-0.5">{children}</div>
      {hint && <p className="mt-1 text-xs text-danger-text">{hint}</p>}
    </div>
  );
}

/** Today, as the date input wants it. */
const today = () => new Date().toISOString().slice(0, 10);

/** What the form starts with. Absent when creating, the order as it stands when editing. */
export interface SalesOrderFormValues {
  customerId: string;
  warehouseId: string;
  orderDate: string;
  expectedDeliveryDate?: string;
  lines: { productId: string; quantity: string; discountPercent: string }[];
}

export interface SalesOrderFormProps {
  initial?: SalesOrderFormValues | undefined;
  title: string;
  subtitle: string;
  submitLabel: string;
  pendingLabel: string;
  pending: boolean;
  /** Whatever the last submission failed with, rendered through the shared wording. */
  error?: unknown;
  onSubmit: (input: NewSalesOrderInput) => void;
  onCancel: () => void;
}
export function SalesOrderForm({
  initial,
  submitLabel,
  pendingLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  title,
  subtitle,
}: SalesOrderFormProps) {

  const customers = useQuery({
    queryKey: queryKeys.customerOptions,
    queryFn: api.masterData.listCustomers,
  });
  const warehouses = useQuery({
    queryKey: queryKeys.warehouseOptions,
    queryFn: api.masterData.listWarehouses,
  });
  const products = useQuery({
    queryKey: queryKeys.productOptions,
    queryFn: api.masterData.listProducts,
  });

  const [customerId, setCustomerId] = useState(initial?.customerId ?? '');
  const [warehouseId, setWarehouseId] = useState(initial?.warehouseId ?? '');
  const [orderDate, setOrderDate] = useState(initial?.orderDate ?? today);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(
    initial?.expectedDeliveryDate ?? '',
  );
  const [lines, setLines] = useState<LineDraft[]>(
    () => initial?.lines.map((line) => ({ ...emptyLine(), ...line })) ?? [emptyLine()],
  );
  const [attempted, setAttempted] = useState(false);

  /**
   * The default warehouse, preselected.
   *
   * Adjusted during render rather than in an effect, which is React's documented way to derive
   * state from data that has just arrived. Only until someone chooses: once a warehouse is set,
   * this stops looking, so it never fights an edit that cleared it.
   */
  const defaultWarehouse = warehouses.data?.find((warehouse) => warehouse.isDefault);
  if (!warehouseId && defaultWarehouse) setWarehouseId(defaultWarehouse.id);
  /**
   * What is obviously wrong before anything is sent.
   *
   * Usability only. Every rule here is also enforced by the server, which is the authority, and
   * none of it is a rule this screen invented: a quantity above zero and a discount between
   * nought and a hundred are the same bounds the creation service applies.
   */
  const problems = useMemo(() => {
    const found: Record<string, string> = {};

    if (!customerId) found['customerId'] = 'A customer is required';
    if (!warehouseId) found['warehouseId'] = 'A warehouse is required';
    if (!orderDate) found['orderDate'] = 'Give the order a date';

    lines.forEach((line, index) => {
      if (!line.productId) found[`${index}.productId`] = 'A product is required';

      const quantity = Number(line.quantity);
      if (!line.quantity.trim() || !Number.isFinite(quantity) || quantity <= 0) {
        found[`${index}.quantity`] = 'More than zero';
      }

      const discount = Number(line.discountPercent);
      if (line.discountPercent.trim() && (!Number.isFinite(discount) || discount < 0 || discount > 100)) {
        found[`${index}.discountPercent`] = 'Between 0 and 100';
      }
    });

    return found;
  }, [customerId, warehouseId, orderDate, lines]);

  const updateLine = (index: number, patch: Partial<LineDraft>) =>
    setLines((current) =>
      current.map((line, at) => (at === index ? { ...line, ...patch } : line)),
    );

  const submit = () => {
    setAttempted(true);
    if (Object.keys(problems).length > 0) return;

    // What was entered, trimmed, with an absent discount absent rather than empty. The caller
    // decides what to do with it; this component never speaks to the network.
    onSubmit({
      customerId,
      warehouseId,
      orderDate,
      ...(expectedDeliveryDate ? { expectedDeliveryDate } : {}),
      lines: lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity.trim(),
        ...(line.discountPercent.trim()
          ? { discountPercent: line.discountPercent.trim() }
          : {}),
      })),
    });
  };

  const show = (field: string) => (attempted ? problems[field] : undefined);

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <>
            <Button onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              onClick={submit}
              disabled={pending}
              title="Creates a draft order. Prices and totals are calculated by the server."
            >
              {pending ? pendingLabel : submitLabel}
            </Button>
          </>
        }
      />

      {error !== null && error !== undefined && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-line-strong bg-danger-soft px-3 py-2"
        >
          <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-danger" />
          <p className="text-sm text-primary">{refusalText(error)}</p>
        </div>
      )}

      <Card padded={false}>
        <CardHeader title="Order details" />
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label="Customer" hint={show('customerId')}>
            <Select
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
              aria-label="Customer"
            >
              <option value="">Choose a customer</option>
              {customers.data?.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.code} · {customer.name}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Warehouse" hint={show('warehouseId')}>
            <Select
              value={warehouseId}
              onChange={(event) => setWarehouseId(event.target.value)}
              aria-label="Warehouse"
            >
              <option value="">Choose a warehouse</option>
              {warehouses.data?.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Order date" hint={show('orderDate')}>
            <input
              type="date"
              value={orderDate}
              onChange={(event) => setOrderDate(event.target.value)}
              aria-label="Order date"
              className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-primary"
            />
          </FormField>

          <FormField label="Expected delivery">
            <input
              type="date"
              value={expectedDeliveryDate}
              onChange={(event) => setExpectedDeliveryDate(event.target.value)}
              aria-label="Expected delivery"
              className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-primary"
            />
          </FormField>
        </div>
      </Card>

      <Card padded={false}>
        <CardHeader
          title="Lines"
          action={
            <Button
              size="sm"
              icon="plus"
              onClick={() => setLines((current) => [...current, emptyLine()])}
            >
              Add line
            </Button>
          }
        />

        <div className="space-y-3 p-4">
          {lines.map((line, index) => (
            <div
              key={line.key}
              className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[1fr_120px_120px_40px]"
            >
              <FormField label={index === 0 ? 'Product' : ''} hint={show(`${index}.productId`)}>
                <Select
                  value={line.productId}
                  onChange={(event) => updateLine(index, { productId: event.target.value })}
                  aria-label={`Product on line ${index + 1}`}
                >
                  <option value="">Choose a product</option>
                  {products.data?.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.sku} · {product.name}
                    </option>
                  ))}
                </Select>
              </FormField>

              <FormField label={index === 0 ? 'Quantity' : ''} hint={show(`${index}.quantity`)}>
                <input
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(event) => updateLine(index, { quantity: event.target.value })}
                  aria-label={`Quantity on line ${index + 1}`}
                  className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-right text-sm text-primary tabular"
                />
              </FormField>

              <FormField label={index === 0 ? 'Discount %' : ''} hint={show(`${index}.discountPercent`)}>
                <input
                  inputMode="decimal"
                  value={line.discountPercent}
                  onChange={(event) => updateLine(index, { discountPercent: event.target.value })}
                  aria-label={`Discount on line ${index + 1}`}
                  className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-right text-sm text-primary tabular"
                />
              </FormField>

              <div className="flex h-8 items-end sm:pt-5">
                <Button
                  size="sm"
                  variant="ghost"
                  icon="close"
                  aria-label={`Remove line ${index + 1}`}
                  disabled={lines.length === 1}
                  title={lines.length === 1 ? 'An order needs at least one line' : 'Remove this line'}
                  onClick={() => setLines((current) => current.filter((_, at) => at !== index))}
                />
              </div>
            </div>
          ))}

          {/*
            NO TOTAL. Pricing belongs to the server, per section 3.3, and a figure computed here
            would be a second opinion about what the customer owes.
          */}
          <p className="text-xs text-muted">
            Prices and totals are applied by the server when the draft is created.
          </p>
        </div>
      </Card>
    </>
  );
}
