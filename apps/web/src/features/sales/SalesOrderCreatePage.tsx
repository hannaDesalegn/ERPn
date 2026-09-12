/**
 * Creating a sales order draft.
 *
 * THE FIRST FORM IN THIS APPLICATION THAT WRITES ANYTHING. Everything before it was a read or a
 * single action on something that already existed, so this is where the boundary between what a
 * person chooses and what the server decides gets drawn for the first time.
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
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { api, queryKeys } from '@/services';
import { Button, Card, CardHeader, Icon, PageHeader, Select } from '@/components/ui';
import { newIdempotencyKey, refusalText } from './refusalText';

/** One line as the form holds it, before anything is sent. */
interface LineDraft {
  /** Local only, so React can key the rows. Never sent. */
  key: string;
  productId: string;
  quantity: string;
  discountPercent: string;
}

const emptyLine = (): LineDraft => ({
  key: newIdempotencyKey(),
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

export function SalesOrderCreatePage() {
  const navigate = useNavigate();

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

  const [customerId, setCustomerId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [orderDate, setOrderDate] = useState(today);
  const [expectedDeliveryDate, setExpectedDeliveryDate] = useState('');
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine()]);
  const [attempted, setAttempted] = useState(false);

  /**
   * One idempotency key for this order, per section 11.
   *
   * Made when the form opens and reused by every retry, so a submission that times out and is
   * sent again is the same intent rather than a second order. A new form gets a new key because
   * this state is created with the component.
   */
  const [idempotencyKey] = useState(newIdempotencyKey);

  /**
   * The default warehouse, preselected.
   *
   * Adjusted during render rather than in an effect, which is React's documented way to derive
   * state from data that has just arrived. Only until someone chooses: once `warehouseId` is set,
   * this stops looking.
   */
  const defaultWarehouse = warehouses.data?.find((warehouse) => warehouse.isDefault);
  if (!warehouseId && defaultWarehouse) setWarehouseId(defaultWarehouse.id);

  const creation = useMutation({
    mutationFn: () =>
      api.sales.createOrder(
        {
          customerId,
          warehouseId,
          orderDate,
          ...(expectedDeliveryDate ? { expectedDeliveryDate } : {}),
          lines: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity.trim(),
            ...(line.discountPercent.trim() ? { discountPercent: line.discountPercent.trim() } : {}),
          })),
        },
        idempotencyKey,
      ),
    onSuccess: (order) => {
      // The server's identifier, never one made here. The detail page then reads the order back
      // from the endpoint rather than being handed a copy.
      navigate(`/sales/orders/${order.id}`);
    },
  });

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
    creation.mutate();
  };

  const show = (field: string) => (attempted ? problems[field] : undefined);

  return (
    <>
      <PageHeader
        title="New sales order"
        subtitle="Saved as a draft. Nothing is reserved or promised until it is confirmed."
        actions={
          <>
            <Button onClick={() => navigate('/sales/orders')} disabled={creation.isPending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon="check"
              onClick={submit}
              disabled={creation.isPending}
              title="Creates a draft order. Prices and totals are calculated by the server."
            >
              {creation.isPending ? 'Creating...' : 'Create draft'}
            </Button>
          </>
        }
      />

      {creation.isError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-line-strong bg-danger-soft px-3 py-2"
        >
          <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-danger" />
          <p className="text-sm text-primary">{refusalText(creation.error)}</p>
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
