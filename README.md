# ERP Frontend

A production-shaped ERP frontend for a wholesale distribution business, built to be
connected to a real backend later. Not a mockup: the domain model, service layer and
permission seams are the deliverable, and the screens exist to prove them.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc -b && vite build
```

**Stack:** Vite · React 19 · TypeScript (strict) · Tailwind v4 · React Router · TanStack Query

> **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the binding architectural contract.** It defines
> the target production system: backend and frontend boundaries, database principles,
> authentication, authorization, auditability, inventory and accounting rules, concurrency,
> idempotency, document lifecycle, testing, security and deployment. Read it before proposing or
> implementing a feature. Section 15.1 lists every temporary behaviour in this repository and what
> removes it; section 15.2 lists what must never be faked; section 16 defines the first vertical
> slice. What follows below describes the frontend as it stands today.

---

## The two ideas the whole codebase rests on

**1. Documents with a lifecycle.** A Sales Order, Purchase Order, Invoice, Payment and
Stock Move are all *documents* moving through states. `draft` is editable and has no
consequences. Confirming or posting is the irreversible moment the document becomes real
and starts affecting other modules. Corrections after posting are new reversing documents,
never silent edits — auditors need to see both the mistake and the fix.

**2. Ledgers, not fields.** Two things are append-only event logs, and everything else is
derived from them:

| Ledger | Derived from it |
|---|---|
| `StockMove[]` | quantity on hand, available, reserved, incoming, inventory valuation |
| `JournalEntry[]` | account balances, trial balance, AR, AP, P&L, balance sheet |

`Product` deliberately has **no `quantityOnHand` field**. Stock is the sum of movements.
This is the single most important modelling decision here — a mutable quantity field makes
the system permanently unauditable, and it is the most common mistake in homemade ERPs.

---

## Layout

```
src/
  domain/       Types. The specification of the business. Backend-agnostic.
  services/     Async API client. The ONLY place that knows where data comes from.
  mocks/        Fake backend: fixtures + derived projections. Deleted when the API lands.
  components/
    ui/         Generic primitives (DataTable, Card, Badge…). Know nothing about ERP.
    domain/     ERP-aware components (StatusBadge, RelatedDocuments, ActivityTimeline).
    charts/     Trend and aging visualisations.
  features/     One folder per module; pages compose the above.
  layouts/      App shell, sidebar, navigation definition.
  app/          Providers: session/permissions, theme, router.
  hooks/        useListParams — URL-synced search/filter/sort/paginate.
  lib/          money.ts (integer arithmetic), format.ts, permissions.ts
```

**The one rule:** components import from `@/services` and `@/domain`, never from `@/mocks`.
That rule is what makes swapping the mock layer for HTTP a contained change.

### Money

Stored as **integer minor units** (`{ amount: 1234, currency: 'USD' }` = $12.34), never a
float. `0.1 + 0.2 !== 0.3` in JavaScript, and a one-cent drift makes a journal entry fail to
balance. All arithmetic lives in `lib/money.ts`; formatting happens only at display.

---

## What is built

Every module has a working list and detail screen, read-only, over fixture data.

| Module | Screens |
|---|---|
| Overview | Dashboard: KPIs, action queue, trends, AR/AP aging, cash, low stock, activity |
| Sales | Sales orders · Customers · Invoices · Deliveries |
| Purchasing | Purchase orders · Suppliers · Bills · Goods receipts |
| Inventory | Products · Stock on hand · Stock movements · Warehouses · Adjustments |
| Finance | Payments · Chart of accounts · General ledger · Journal entries · Trial balance |
| Admin | Users and roles with a permission matrix · Audit log |

**One placeholder remains: stock transfers.** The type exists, the workflow does not. There
are no fixtures, the in-transit state has no owner, and a transfer arguably needs a virtual
location rather than the signed quantity the rest of inventory uses. Building it would mean
inventing the business process, so it stays visibly unbuilt.

That is the standard applied throughout: **fake data yes, fake functionality no.** Where a
domain is defined, the screen is built against realistic fixtures. Action buttons that would
mutate data are rendered disabled, gated on both permission and document state, each with a
tooltip saying what it would do.

### Verified

- `npm run build` passes with TypeScript `strict` + `noUncheckedIndexedAccess`
- Fixture generator asserts every journal entry balances; **trial balance debits = credits exactly**
- No product has negative stock on hand across 330 movements
- 34 sales orders carry a complete trail: order → delivery → invoice → payment → journal entry
- Sidebar contrast computed, not eyeballed: lowest pair 6.03:1, all pass WCAG AA
- Shipped bundle contains zero em dashes and zero en dashes

---

## Deliberate boundaries

**Frontend permission checks are usability, not security.** `can('sales:confirm')` decides
what to *render*. It decides nothing about what is *allowed*. Every permission must be
re-checked server-side on every request. The role switcher in the top bar is a review tool,
not authentication.

**The audit trail here is a UI contract, not a secure log.** A trustworthy one requires the
backend to write the entry in the same transaction as the change, take the actor from the
session rather than the request body, and make the table append-only.

**Aggregates belong to the backend.** The dashboard renders totals; it does not compute them
from a page of rows. Two clients with different page sizes would otherwise report different
figures, and nobody could reconcile the dashboard against the ledger.

**Backend is not chosen.** Nothing here assumes Django, Odoo or ERPNext. Odoo speaks JSON-RPC
with domain filters like `[['state','=','sale']]`; ERPNext uses `/api/resource/<Doctype>`.
Neither matches this shape exactly — the adapter belongs in `services/`, in one folder, and
the UI never learns which backend won.

---

## Roadmap

**Next**
1. Create/edit forms, starting with the sales order. Deferred until now on purpose: line
   items, tax, discounts and validation are where ERP time disappears, and read-only screens
   proved the model first.
2. Define the stock transfer workflow, then build it and remove the last placeholder.
3. Remove the duplicated `Account.balance` in `mocks/reference.ts` so the ledger is the only
   source of account balances.

**Then**
4. Profit and loss, and balance sheet. Types exist in `domain/accounting.ts`; no service yet.
5. A real three-way match comparison view putting PO, receipt and bill side by side.
6. Global search across documents, which is why the topbar has no search box today.

**Later**
7. Real backend plus authentication. Delete `mocks/`, keep the service signatures, drop the
   `setClock` line in `services/index.ts`.
8. Server-driven aggregates and pagination.
9. Mutations with cross-module cache invalidation. Posting an invoice must invalidate the
   customer balance, the AR aging *and* the dashboard, which is why `queryKeys` is centralised.

---

## Known gaps

- `mocks/reference.ts` seeds static balances on the chart of accounts that do **not** match
  the balances derived from journal entries. Only the derived figures reach the UI today, so
  nothing contradicts on screen — but the Chart of Accounts screen must read from
  `api.finance.trialBalance()`, not from `Account.balance`, or it will show two different
  truths.
- Inventory uses a single warehouse plus a signed quantity. Mature ERPs move stock between
  *locations* including virtual ones (Supplier, Customer, Scrap), making goods double-entry
  too. `MovementReason` preserves the information needed to upgrade later.
- Multi-currency is typed but not exercised; `lib/money.ts` throws on cross-currency
  arithmetic rather than guessing a rate.
