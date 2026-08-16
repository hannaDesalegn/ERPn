/**
 * Honest placeholder for routes that are designed but not yet built.
 *
 * This is deliberately NOT a fake screen with lorem data. A stub that pretends
 * to work is worse than an empty one: it hides the true state of the project
 * from whoever reviews it. Each placeholder states what the screen is for, which
 * domain types already exist for it, and what remains — so the roadmap is
 * visible inside the product.
 */

import { Link } from 'react-router-dom';
import { Card, Icon, PageHeader, type IconName } from '@/components/ui';

export function Placeholder({
  title,
  purpose,
  icon = 'box',
  readyTypes,
  remaining,
}: {
  title: string;
  purpose: string;
  icon?: IconName;
  /** Domain types/services that already model this screen. */
  readyTypes: string[];
  remaining: string[];
}) {
  return (
    <>
      <PageHeader title={title} subtitle={purpose} />

      <Card className="max-w-3xl">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-muted">
            <Icon name={icon} className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-primary">Not yet defined</h2>
            <p className="mt-1 text-sm text-secondary">
              Types exist, but the workflow behind this screen is not settled. Building it would
              mean inventing the business process, so it is left unbuilt on purpose.
            </p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-2xs font-medium tracking-wide text-muted uppercase">
                  Types that exist
                </p>
                <ul className="mt-1.5 space-y-1">
                  {readyTypes.map((item) => (
                    <li key={item} className="flex items-start gap-1.5 text-xs text-secondary">
                      <Icon name="check" className="mt-0.5 size-3 shrink-0 text-success" />
                      <code className="font-mono">{item}</code>
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <p className="text-2xs font-medium tracking-wide text-muted uppercase">
                  Decisions needed first
                </p>
                <ul className="mt-1.5 space-y-1">
                  {remaining.map((item) => (
                    <li key={item} className="flex items-start gap-1.5 text-xs text-secondary">
                      <Icon name="clock" className="mt-0.5 size-3 shrink-0 text-muted" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <p className="mt-4 border-t border-line pt-3 text-xs text-muted">
              This is the only unbuilt screen in the application. Every other route is a working
              view over the domain model.{' '}
              <Link to="/inventory/stock" className="text-accent-text hover:underline">
                Stock on hand
              </Link>{' '}
              and{' '}
              <Link to="/inventory/movements" className="text-accent-text hover:underline">
                stock movements
              </Link>{' '}
              cover the rest of inventory.
            </p>
          </div>
        </div>
      </Card>
    </>
  );
}

export function NotFoundPage() {
  return (
    <div className="grid place-items-center py-24 text-center">
      <Icon name="search" className="size-6 text-muted" />
      <h1 className="mt-2 text-lg font-semibold text-primary">Page not found</h1>
      <p className="mt-1 text-sm text-muted">That route does not exist in the application.</p>
      <Link to="/" className="mt-3 text-sm text-accent-text hover:underline">
        Back to dashboard
      </Link>
    </div>
  );
}
