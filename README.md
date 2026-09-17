# ERP (internship project)

A multi-tenant ERP for a wholesale distribution business, built as an internship project. It is
**not a complete ERP product.** The scope is deliberately small: a few workflows built for real,
with the security properties a real system needs, instead of many modules that only look
finished.

It is meant to be run from an empty database, demonstrated in a browser, and handed to a
security team for testing.

**Stack:** NestJS 12 on Fastify, PostgreSQL 17 with row level security, Drizzle, React 19, Vite,
Tailwind, TanStack Query.

`docs/ARCHITECTURE.md` is the design contract the code is built against. You do not need to
read it to run the system.

---

## Quick start

### Prerequisites

- Node.js 24 (CI pins 24.16.0). The scripts use `node --env-file-if-exists`, which needs Node 22.9
  or later.
- Docker, for PostgreSQL. Only the database runs in a container; the API and the frontend run
  on your machine.
- Ports 5432, 3000 and 5173 free on `127.0.0.1`.

### From nothing to a running demo

Run these from the repository root.

```bash
npm install

# Configuration for the API, the migration runner and the demo seed.
cp apps/api/.env.example apps/api/.env

# A fresh database. db:reset destroys any existing local database volume.
npm run db:reset

# Create the schema.
npm run db:migrate

# Create the demo tenants, companies, accounts, master data and opening stock.
npm run db:seed:demo

# In two terminals:
npm run dev:api    # API on http://127.0.0.1:3000
npm run dev:web    # Browser app on http://localhost:5173
```

Open http://localhost:5173 and sign in with one of the demo accounts below.

If the page shows "Cannot reach the server", the API is not running or not ready yet.
`http://127.0.0.1:3000/health/ready` answers 200 once it can reach the database.

### Starting again

The seed refuses to run when any demo tenant or demo account already exists, and writes nothing
in that case. To rebuild the environment from scratch:

```bash
npm run db:reset && npm run db:migrate && npm run db:seed:demo
```

---

## Demo environment

`npm run db:seed:demo` creates the same environment on every machine. Every identifier is fixed,
so a record from one company can be named in a request made from another and the result is
predictable.

### Accounts

Every account uses the password in `DEMO_USER_PASSWORD`. With the copied `.env.example`, that is
`erp_demo_local_dev`. It is a local development value, not a secret, and the seed refuses to run
when `NODE_ENV=production`.

| Email | Role | Companies |
|---|---|---|
| `demo-admin@erp.test` | Administrator | Demo Distribution East, Demo Distribution West |
| `demo-sales@erp.test` | Sales Representative | Demo Distribution East, Demo Distribution West |
| `demo-accountant@erp.test` | Accountant | Demo Distribution East only |
| `demo-warehouse@erp.test` | Warehouse Operator | Demo Distribution East only |
| `demo-trading-admin@erp.test` | Administrator | Demo Trading only (a different tenant) |

What each role may do is defined in `apps/api/src/authorization/permissions.ts`. In short:

- **Administrator:** everything, including cancelling orders, user roles and the audit log.
- **Sales Representative:** view, create and confirm sales orders, view customers and stock. Cannot
  cancel an order, post an invoice or read the audit log.
- **Accountant:** invoices, invoice posting, accounting and the audit log. Can view sales orders
  but cannot create or confirm them.
- **Warehouse Operator:** stock and read-only sales orders. Cannot see customers or prices.

Signing in is throttled per address and per account: by default 10 failed attempts within 15
minutes lock further attempts for 15 minutes (`AUTH_*` settings in `apps/api/.env`). Keep that in
mind when testing passwords against the demo accounts.

### Tenants and companies

| Tenant | Company | Warehouse | Customers | Products |
|---|---|---|---|---|
| Demo Distribution Group (`demo-distribution`) | Demo Distribution East | East Main Warehouse | 3 | 4 |
| | Demo Distribution West | West Main Warehouse | 2 | 2 |
| Demo Trading Ltd (`demo-trading`) | Demo Trading | Trading Warehouse | 1 | 1 |

Every company is created by the application's own company provisioning, so each has its six
default roles, its sales order and customer invoice number sequences, its chart of accounts and
its posting account mapping. All companies use USD.

**Codes collide on purpose.** Every company has a `CUST-001` and a `SKU-1001`, with different names
and different stock, so a leak between companies is visible rather than looking like correct data.

The two tenants are fully isolated from each other. The two companies in the first tenant share
the tenant but not their data: switching company changes everything you see.

### Opening stock

| Company | SKU | Product | On hand |
|---|---|---|---|
| Demo Distribution East | SKU-1001 | Copy paper A4 80gsm, box of 5 reams | 400 box |
| | SKU-1002 | Ballpoint pens blue, box of 50 | 250 box |
| | SKU-1003 | Heavy duty stapler | 120 unit |
| | SKU-1004 | Archive storage box | **5 unit** |
| Demo Distribution West | SKU-1001 | Copy paper Letter 20lb, box of 10 reams | 150 box |
| | SKU-2001 | Packing tape, roll | 600 unit |
| Demo Trading | SKU-1001 | Thermal receipt rolls, box of 50 | 80 box |

`SKU-1004` is stocked short on purpose: confirming an order for 6 of them is refused, which shows
the oversell check.

Opening stock is written through the stock ledger, the same way every stock change is: one
movement per product with reason `adjustment` and source document type `opening_stock`, the
balance row updated in the same transaction, and an `opening_stock_recorded` audit event in that
transaction too. It is a quantity load only. No journal entry is written for it, because the
system has no inventory valuation or inventory account yet.

### A first walkthrough

The full demo runs from a sales order to a posted invoice, and it takes two people. The
salesperson sells, and the accountant bills and posts. Neither role can do the other's half,
which is the point.

**As the salesperson**

1. Sign in as `demo-sales@erp.test`.
2. Use the company selector in the top bar to switch between East and West, then choose
   **Demo Distribution East**.
3. Open **Sales orders** and create an order for `CUST-001` with 10 of `SKU-1001`.
4. Confirm it. It receives the number `SO-0001` and reserves 10 boxes.
5. Create a second order for 6 of `SKU-1004` and try to confirm it. It is refused: only 5 are
   available.

The salesperson sees no **Create invoice** button: raising an invoice needs `invoices:create`,
which the sales role does not hold.

**As the accountant**

6. Sign out and sign in as `demo-accountant@erp.test`. East is the only company this account
   belongs to.
7. Open **Sales orders**, open `SO-0001`, and choose **Create invoice**. A draft invoice opens,
   billing everything on the order at the prices the order agreed.
8. Choose **Post invoice**. The invoice receives the number `INV-0001` and its status becomes
   Posted.
9. The **Journal entry** panel shows what posting wrote: Accounts Receivable debited and Sales
   Revenue credited by the invoice total. There is no tax line, because the demo companies charge
   0% tax and a zero tax line is not written.
10. The **History** panel shows the posting event, who posted it, their role, and the amount.

**Checking the boundaries**

11. Open the same invoice as `demo-sales@erp.test`. It can be read, there is no **Post invoice**
    button, and the journal and history panels say the account lacks permission.
12. Switch the salesperson to West and open the invoice's address again: it is not found. The
    same happens for `demo-trading-admin@erp.test`, in the other tenant.
13. Sign in as `demo-admin@erp.test` to cancel an order and to see a sales order's history panel.

An invoice is reached from its sales order or by its address. The invoice list is still sample
data, so it does not list real invoices.

---

## What is real, and what is not

### Real, end to end

- Sign in, sign out, server side sessions, CSRF protection, login throttling.
- Company membership and company switching, resolved on the server. A company or tenant is
  never taken from a request.
- Authorization on every API route, checked on the server per request, with row level security
  in PostgreSQL as a second layer.
- Sales orders in the browser: list, create, edit a draft, confirm, cancel, and the audit history
  of a confirmed order.
- Confirming an order: server side pricing, gapless document numbers, stock reservation with
  locking, optimistic concurrency, idempotent retries, and an audit record in the same
  transaction.
- Customer invoices in the browser: create a draft from a confirmed order, view it, post it, and
  see the journal entry and audit record the posting wrote. Posting allocates a gapless invoice
  number, consumes the invoiced quantities under lock, writes a balanced entry and an audit record,
  and commits all of it or none of it. Retries are idempotent.
- Editing an invoice draft and raising one from several orders exist over the API
  (`PUT /api/customer-invoices/:id`), with no screen.

### Sample data only

Every other screen in the browser still renders built-in fixture data and is not connected to
the server. Those screens are marked **Sample** in the sidebar and carry a notice at the top of
the page. This includes the dashboard, customers, products, stock, the invoice list, deliveries,
purchasing, finance, accounting, users and roles, and the audit log screen. Nothing on them is
saved.

### Intentionally deferred

- A real invoice list, editing an invoice draft in the browser, and invoicing part of an order.
- The general ledger, trial balance, payment, purchasing, delivery and credit note workflows.
  The journal is visible only per posted invoice.
- Cost of goods sold, inventory valuation, opening balance journal entries.
- Accounting periods, credit limits, unit of measure conversion.
- Creating tenants, companies, users or invitations from the interface. Tenants and companies
  exist only through the demo seed.
- A company tax rate other than zero. Every demo company has a standard rate of 0%, because no
  endpoint sets one yet.

---

## Configuration

`apps/api/.env.example` lists every variable with a comment. The ones that matter to run the demo:

| Variable | Used by | Default in `.env.example` |
|---|---|---|
| `DATABASE_URL` | API | `erp_app` role on `127.0.0.1:5432/erp_dev` |
| `MIGRATION_DATABASE_URL` | Migrations and the demo seed, never the API | `erp_migrator` role |
| `APP_DB_ROLE` | Migrations | `erp_app` |
| `DEMO_USER_PASSWORD` | Demo seed only, at least 12 characters | `erp_demo_local_dev` |
| `COOKIE_SECURE` | API. Must be true in production | `false` |
| `TRUSTED_ORIGINS` | API, for cross origin browsers | empty, same origin only |

The database container needs no configuration. Its defaults are in `docker-compose.yml` and can be
overridden with a root `.env` file.

### Database roles

Two roles, neither of them a superuser, created by `docker/postgres/init/01-roles.sh` when the
database volume is first created:

- `erp_migrator` owns the schema and runs migrations. The demo seed also uses it for one thing:
  creating the two tenant rows, which the application role is not allowed to do.
- `erp_app` is what the API connects as. It cannot change the schema, cannot bypass row level
  security, and cannot update or delete audit records.

After changing the init script, run `npm run db:reset`.

---

## Commands

| Command | What it does |
|---|---|
| `npm run db:up` | Start PostgreSQL and wait until it accepts connections |
| `npm run db:down` | Stop PostgreSQL |
| `npm run db:reset` | Destroy the database volume and start PostgreSQL empty |
| `npm run db:migrate` | Apply pending migrations. `-- --dry-run` only reports them |
| `npm run db:seed:demo` | Create the demo environment on a migrated, empty database |
| `npm run dev:api` | API with reload, port 3000 |
| `npm run dev:web` | Browser app, port 5173, proxying `/api` to the API |
| `npm run build` | Build both workspaces |
| `npm run typecheck` | Type check both workspaces |
| `npm run lint` | Lint the web workspace |
| `npm test` | Unit tests, no database needed |
| `npm run test:int` | API integration tests, needs the database migrated |

Health endpoints: `/health` answers whether the process is alive, and `/health/ready` whether it
can reach the database.

### Integration tests share the local database

`npm run test:int` runs against the same database as the demo, and several test files clear
tables they share with it, including the audit trail. The demo seed's own test removes the demo
environment before and after it runs. After running the integration tests, rebuild the demo:

```bash
npm run db:reset && npm run db:migrate && npm run db:seed:demo
```

The integration tests read `DATABASE_URL` and `MIGRATION_DATABASE_URL` from the environment, not
from `apps/api/.env`, so export them first.

### Continuous integration

`.github/workflows/ci.yml` runs type checking, lint, unit tests, build, integration tests against
a real PostgreSQL, a dependency audit and a secret scan on every push.

---

## Repository layout

```
apps/api/            NestJS API
  migrations/        Handwritten SQL migrations, forward only and checksummed
  src/demo/          The demo dataset and seed
apps/web/            React frontend
  src/services/      The only code that fetches data, real or fixture
  src/mocks/         Fixture data behind the Sample screens
docs/ARCHITECTURE.md Design contract
docker-compose.yml   PostgreSQL only
```
