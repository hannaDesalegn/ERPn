/**
 * Creating a sales order draft.
 *
 * The form is shared with editing one. What belongs to creating, and so lives here, is the
 * mutation, the idempotency key and where to go afterwards.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { api } from '@/services';
import type { NewSalesOrderInput } from '@/services/sales.service';
import { newIdempotencyKey } from './refusalText';
import { SalesOrderForm } from './SalesOrderForm';

export function SalesOrderCreatePage() {
  const navigate = useNavigate();

  /**
   * One idempotency key for this order, per section 11.
   *
   * Made when the form opens and reused by every retry, so a submission that times out and is
   * sent again is the same intent rather than a second order. A fresh form gets a fresh key,
   * because this state is created with the component.
   */
  const [idempotencyKey] = useState(newIdempotencyKey);

  const creation = useMutation({
    mutationFn: (input: NewSalesOrderInput) => api.sales.createOrder(input, idempotencyKey),
    onSuccess: (order) => {
      // The server's identifier, never one made here. The detail page then reads the order back
      // from the endpoint rather than being handed a copy.
      navigate(`/sales/orders/${order.id}`);
    },
  });

  return (
    <SalesOrderForm
      title="New sales order"
      subtitle="Saved as a draft. Nothing is reserved or promised until it is confirmed."
      submitLabel="Create draft"
      pendingLabel="Creating..."
      pending={creation.isPending}
      error={creation.error}
      onSubmit={(input) => creation.mutate(input)}
      onCancel={() => navigate('/sales/orders')}
    />
  );
}
