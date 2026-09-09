/**
 * Status rendering.
 *
 * ONE PLACE decides what every status looks like. Inline colour choices spread
 * across screens are how "confirmed" ends up green on one page and blue on
 * another, which quietly teaches users that colour means nothing.
 *
 * THE COLOUR LANGUAGE, applied consistently:
 *   neutral  nothing has happened yet (draft) — deliberately colourless
 *   info     in progress, no action needed from you
 *   warning  waiting on a human decision
 *   success  completed cleanly
 *   danger   needs intervention (overdue, failed match)
 *   muted    cancelled — visible but withdrawn from the flow
 *
 * Colour is never the only signal: every badge carries its label as text.
 */

import type { BadgeTone } from '@/components/ui';
import { Badge } from '@/components/ui';
import { humanize } from '@/lib/format';

const STATUS_TONES: Record<string, BadgeTone> = {
  // Shared
  draft: 'neutral',
  cancelled: 'neutral',
  posted: 'info',
  reversed: 'neutral',

  // Sales orders
  confirmed: 'info',
  partially_delivered: 'warning',
  delivered: 'success',
  invoiced: 'success',

  // Deliveries
  ready: 'warning',
  shipped: 'info',

  // Purchase orders
  pending_approval: 'warning',
  approved: 'info',
  partially_received: 'warning',
  received: 'success',
  billed: 'success',

  // Invoices & payments
  partially_paid: 'warning',
  paid: 'success',
  overdue: 'danger',
  reconciled: 'success',

  // Stock transfers
  in_transit: 'info',

  // Three-way match
  matched: 'success',
  quantity_variance: 'danger',
  price_variance: 'danger',
  not_matched: 'warning',
};

/** Statuses that mean "this document no longer counts". */
const WITHDRAWN = new Set(['cancelled', 'reversed']);

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  return (
    <Badge tone={tone} dot className={className}>
      <span className={WITHDRAWN.has(status) ? 'line-through opacity-70' : undefined}>
        {humanize(status)}
      </span>
    </Badge>
  );
}

export function statusTone(status: string): BadgeTone {
  return STATUS_TONES[status] ?? 'neutral';
}
