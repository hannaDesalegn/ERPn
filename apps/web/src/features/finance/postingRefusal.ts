/**
 * What to show when the server refuses to post an invoice.
 *
 * THE SERVER'S CONTRACT, READ AS IT IS. A refusal the business can explain arrives as 422 with a
 * sentence saying what is wrong: that a sales order line no longer has enough left to invoice,
 * that the company's tax rate moved since the draft was raised, or that the invoice comes to
 * nothing. Those sentences are shown as written, under a heading, because they already tell the
 * accountant what happened and a paraphrase here would drift from them.
 *
 * Where the server deliberately says little, this supplies a sentence that is useful without
 * adding anything it did not say. A 403 is the capability missing in this company. A 409 is the
 * invoice having moved, most often because someone else posted it first, so the screen reloads it.
 *
 * NO BUSINESS RULE IS DECIDED HERE. The refusal already happened.
 */

import { ApiError } from '@/services/client';
import { refusalText } from '@/features/sales/refusalText';

export interface PostingRefusal {
  title: string;
  detail: string;
  /** Whether the invoice on screen may now be out of date and should be read again. */
  reload: boolean;
}

export function postingRefusal(error: unknown): PostingRefusal {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return {
        title: 'Not permitted',
        detail: 'You do not have permission to post invoices in this company.',
        reload: false,
      };
    }

    if (error.status === 409) {
      return {
        title: 'The invoice has changed',
        detail: `${error.message.replace(/\.$/, '')}. The invoice has been reloaded to show its current state.`,
        reload: true,
      };
    }

    if (error.status === 422) {
      return { title: 'This invoice cannot be posted', detail: error.message, reload: true };
    }
  }

  return { title: 'The invoice was not posted', detail: refusalText(error), reload: false };
}
