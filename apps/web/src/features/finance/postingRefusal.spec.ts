import { ApiError } from '@/services/client';
import { postingRefusal } from './postingRefusal';

/**
 * The server's own sentences, copied from `post-customer-invoice.ts` and
 * `customer-invoice-status.ts`, so these tests read the contract rather than an imagined one.
 */
const SERVER = {
  quantity_exceeded: 'That sales order line no longer has enough left to invoice',
  tax_rate_changed:
    'This invoice was raised at 10.000000 per cent tax and the company now charges 12.000000. Re-read the draft and post it again.',
  nothing_to_post: 'This invoice comes to nothing, so there is no entry to post',
  already_posted: 'A customer invoice cannot move from posted to posted',
};

describe('what a refused posting says', () => {
  it.each([
    ['quantity_exceeded', SERVER.quantity_exceeded],
    ['tax_rate_changed', SERVER.tax_rate_changed],
    ['nothing_to_post', SERVER.nothing_to_post],
  ])('shows %s in the words the server used, and reloads the invoice', (_reason, message) => {
    const refusal = postingRefusal(new ApiError(422, message));

    expect(refusal).toEqual({ title: 'This invoice cannot be posted', detail: message, reload: true });
  });

  it('explains a 403 as the capability missing in this company, without reloading', () => {
    expect(postingRefusal(new ApiError(403, 'Forbidden'))).toEqual({
      title: 'Not permitted',
      detail: 'You do not have permission to post invoices in this company.',
      reload: false,
    });
  });

  it('explains a 409 as the invoice having moved, and reloads it', () => {
    const refusal = postingRefusal(new ApiError(409, SERVER.already_posted));

    expect(refusal.title).toBe('The invoice has changed');
    expect(refusal.detail).toBe(
      'A customer invoice cannot move from posted to posted. The invoice has been reloaded to show its current state.',
    );
    expect(refusal.reload).toBe(true);
  });

  it('does not double a full stop the server already wrote', () => {
    expect(postingRefusal(new ApiError(409, 'Moved.')).detail).toMatch(/^Moved\. The invoice/);
  });

  it('never falls back to a generic sentence for a refusal the server explained', () => {
    for (const status of [403, 409, 422]) {
      expect(postingRefusal(new ApiError(status, 'x')).detail).not.toMatch(/something went wrong/i);
    }
  });

  it('says the server could not be reached when nothing answered', () => {
    expect(postingRefusal(new TypeError('Failed to fetch')).detail).toMatch(/could not be reached/);
  });
});
