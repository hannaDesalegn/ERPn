/**
 * Application shell: persistent sidebar, top bar, content region.
 *
 * LAYOUT DECISION — a fixed left sidebar rather than a top nav.
 * ERP navigation is deep (six groups, ~20 destinations). A horizontal menu
 * cannot hold that without dropdowns, and dropdowns cost a click and hide the
 * user's location. A persistent sidebar keeps the whole map visible, which is
 * what makes navigation predictable in software people use all day.
 */

import { useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon } from '@/components/ui';
import { useSession } from '@/app/session';
import { useTheme } from '@/app/theme';
import { NAV_SECTIONS } from './navigation';
import { cn, initials } from '@/lib/format';

export function AppShell({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-full">
      {/* Backdrop for the mobile drawer */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <Sidebar open={mobileOpen} onNavigate={() => setMobileOpen(false)} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenuClick={() => setMobileOpen(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">{children}</main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const { can, activeCompany } = useSession();
  const location = useLocation();

  return (
    <nav
      aria-label="Main navigation"
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col bg-sidebar transition-transform lg:static lg:translate-x-0',
        open ? 'translate-x-0' : '-translate-x-full',
      )}
    >
      {/* No logo mark. Nothing to represent until the product has a real
          identity, and an invented monogram is decoration pretending to be one. */}
      <div className="flex h-12 items-center border-b border-sidebar-line px-4">
        {/* The company this session is inside, from /me. It used to be a fixture constant,
            which meant every tenant saw the same name at the top of their own data. */}
        <span className="truncate text-sm font-semibold text-primary">{activeCompany.name}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter((item) => !item.permission || can(item.permission));
          // Hide a whole section rather than show an empty heading.
          if (visible.length === 0) return null;

          return (
            <div key={section.label} className="mb-4">
              {/* No icon here: the heading is not interactive, and decorating
                  it while leaving the actual links bare inverts the usual
                  convention and adds noise to the rail. */}
              <p className="mb-1 px-2 text-2xs font-semibold tracking-wider text-sidebar-heading uppercase">
                {section.label}
              </p>
              <ul>
                {visible.map((item) => {
                  const active =
                    item.to === '/'
                      ? location.pathname === '/'
                      : location.pathname.startsWith(item.to);
                  return (
                    <li key={item.to}>
                      <NavLink
                        to={item.to}
                        onClick={onNavigate}
                        className={cn(
                          'block rounded-md px-2 py-1.5 text-sm transition-colors',
                          active
                            ? 'bg-sidebar-active font-medium text-sidebar-active-text'
                            : 'text-sidebar-text hover:bg-sidebar-hover hover:text-sidebar-active-text',
                        )}
                      >
                        {item.label}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="border-t border-sidebar-line px-3 py-2">
        <p className="text-2xs text-sidebar-heading">
          Business data is still fixtures. Identity is not.
        </p>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------

function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const { user, roles, activeCompany, companies, switchCompany, signOut } = useSession();
  const { theme, toggle } = useTheme();
  const [busy, setBusy] = useState(false);

  /**
   * Asks the server to change company.
   *
   * The select is not the source of truth and is never set optimistically. It renders whatever
   * `/me` currently says, so a switch the server refuses leaves it exactly where it was.
   */
  const onCompanyChange = async (companyId: string) => {
    if (companyId === activeCompany.id) return;

    setBusy(true);
    try {
      await switchCompany(companyId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 lg:px-6">
      <button
        type="button"
        onClick={onMenuClick}
        aria-label="Open navigation"
        className="rounded p-1.5 text-secondary hover:bg-hover lg:hidden"
      >
        <Icon name="menu" className="size-4" />
      </button>

      {/*
        Global search is not built yet, so there is no search box here.
        A focusable input that silently does nothing is worse than an absent
        one: it looks finished. Add it back when it actually searches.
      */}

      <div className="flex flex-1 items-center justify-end gap-2">
        {/*
          COMPANY SWITCHER. Shown only when this person may enter more than one, because a
          select with a single option is a control that cannot do anything.
        */}
        {companies.length > 1 && (
          <div className="hidden items-center gap-2 rounded-md border border-line py-0.5 pr-1 pl-2 sm:flex">
            <label className="sr-only" htmlFor="company-switcher">
              Active company
            </label>
            <select
              id="company-switcher"
              value={activeCompany.id}
              disabled={busy}
              onChange={(e) => void onCompanyChange(e.target.value)}
              className="max-w-40 cursor-pointer truncate bg-transparent text-xs font-medium text-primary focus:outline-none disabled:cursor-wait"
            >
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <button
          type="button"
          onClick={toggle}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className="rounded p-1.5 text-secondary hover:bg-hover"
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} className="size-4" />
        </button>

        {/*
          The signed-in person. Not a switcher: there is no way to become someone else from
          here, which is the whole difference between this and what it replaced.
        */}
        <div className="flex items-center gap-2 rounded-md border border-line px-2 py-1">
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-2xs font-semibold text-accent-text">
            {initials(user.name)}
          </span>
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-xs font-medium text-primary" title={user.email}>
              {user.name}
            </p>
            {roles.length > 0 && (
              <p className="truncate text-2xs text-muted">
                {roles.map((role) => role.name).join(', ')}
              </p>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded p-1.5 text-secondary hover:bg-hover"
          aria-label="Sign out"
          title="Sign out"
        >
          <Icon name="logout" className="size-4" />
        </button>

        <Link
          to="/admin/audit"
          className="hidden rounded p-1.5 text-secondary hover:bg-hover md:block"
          aria-label="Activity log"
        >
          <Icon name="history" className="size-4" />
        </Link>
      </div>
    </header>
  );
}
