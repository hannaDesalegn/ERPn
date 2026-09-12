/**
 * Editing a sales order draft.
 *
 * The form is shared with creating one. What belongs to editing, and so lives here, is loading the
 * order to start from, carrying its version, and explaining a conflict.
 *
 * THE CONFLICT IS A STATE, NOT A MESSAGE. Section 10.1 requires the interface to surface one as a
 * real, explained state rather than a generic error, so a 409 stops showing the form and shows
 * what the order is now, with a way back to it. The endpoint sends that order in the refusal body
 * precisely so this screen does not have to fetch it and end up describing a third state.
 */

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import { api, queryKeys } from '@/services';
import { ApiError } from '@/services/client';
import type { NewSalesOrderInput, SalesOrderDetail } from '@/services/sales.service';
import { Button, Card, ErrorState, Icon, PageHeader, Skeleton } from '@/components/ui';
import { newIdempotencyKey } from './refusalText';
import { SalesOrderForm, type SalesOrderFormValues } from './SalesOrderForm';

/** The order as the form wants it to start. */
function startingValues(order: SalesOrderDetail): SalesOrderFormValues {
  return {
    customerId: order.customer.id,
    warehouseId: order.warehouse.id,
    orderDate: order.orderDate,
    ...(order.expectedDeliveryDate ? { expectedDeliveryDate: order.expectedDeliveryDate } : {}),
    lines: order.lines.map((line) => ({
      productId: line.productId,
      // Rendered as the server holds them, so an untouched line is sent back unchanged.
      quantity: String(line.quantity),
      discountPercent: line.discountPercent ? String(line.discountPercent) : '',
    })),
  };
}

/** The order carried in a 409 body, when the server sent one. */
function conflictingOrder(error: unknown): SalesOrderDetail | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;

  const body = error.body;
  if (typeof body !== 'object' || body === null) return null;

  const current = (body as { current?: unknown }).current;
  return current && typeof current === 'object' ? (current as SalesOrderDetail) : null;
}

export function SalesOrderEditPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  /**
   * One idempotency key for this edit, per section 11.
   *
   * Made when the screen opens and reused by every retry, so a submission that times out and is
   * sent again is the same intent rather than a second edit.
   */
  const [idempotencyKey] = useState(newIdempotencyKey);

  const order = useQuery({
    queryKey: queryKeys.salesOrder(id),
    queryFn: () => api.sales.getOrder(id),
  });

  const update = useMutation({
    mutationFn: (input: NewSalesOrderInput) =>
      api.sales.updateOrder(id, { ...input, version: order.data?.version ?? 0 }, idempotencyKey),
    onSuccess: (updated) => navigate(`/sales/orders/${updated.id}`),
  });

  const conflict = conflictingOrder(update.error);

  if (order.isError) {
    return (
      <ErrorState
        message={(order.error as Error).message}
        onRetry={() => navigate('/sales/orders')}
      />
    );
  }

  if (order.isLoading || !order.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 rounded-lg" />
        <Skeleton className="h-96 rounded-lg" />
      </div>
    );
  }

  if (order.data.status !== 'draft') {
    // Section 12.2: only a draft is editable. Reached by typing the URL, since nothing links here
    // for a confirmed order, and answered plainly rather than by a form that would be refused.
    return (
      <>
        <PageHeader title="This order cannot be edited" />
        <Card>
          <p className="text-sm text-secondary">
            {order.data.docNumber ?? 'This order'} is {order.data.status}. Only a draft can be
            edited, and a confirmed order is corrected by a new document.
          </p>
          <Button className="mt-3" onClick={() => navigate(`/sales/orders/${id}`)}>
            Back to the order
          </Button>
        </Card>
      </>
    );
  }

  if (conflict) {
    return (
      <>
        <PageHeader title="Somebody else changed this order" />
        <Card>
          <div role="alert" className="flex items-start gap-2">
            <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="space-y-2">
              <p className="text-sm text-primary">
                Your changes were not saved, because the order was edited while you were working on
                it. Nothing you entered has been applied.
              </p>
              <p className="text-sm text-secondary">
                It now has {conflict.lines.length}{' '}
                {conflict.lines.length === 1 ? 'line' : 'lines'} and is dated{' '}
                {conflict.orderDate}. Open it to see the current version and start again.
              </p>
            </div>
          </div>
          <Button variant="primary" className="mt-3" onClick={() => navigate(`/sales/orders/${id}`)}>
            Open the current order
          </Button>
        </Card>
      </>
    );
  }

  return (
    <SalesOrderForm
      initial={startingValues(order.data)}
      title={`Edit ${order.data.docNumber ?? 'draft order'}`}
      subtitle="Still a draft. Nothing is reserved or promised until it is confirmed."
      submitLabel="Save changes"
      pendingLabel="Saving..."
      pending={update.isPending}
      error={update.error}
      onSubmit={(input) => update.mutate(input)}
      onCancel={() => navigate(`/sales/orders/${id}`)}
    />
  );
}
