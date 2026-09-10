# Production Architecture

**Status:** active architectural contract
**Created:** 2026-09-09
**Applies to:** the entire ERP system, backend and frontend

---

## How to use this document

This document is the architectural contract for the project. It exists because the
repository currently contains a well built frontend over fixture data, and the goal is a
production ERP for wholesale distribution. Those two things have very different
requirements, and the gap between them has to be crossed deliberately rather than by
accretion.

Three rules govern it.

1. **Check before you build.** Before implementing a feature, check the proposal against
   this document. If the proposal violates a `[DEC]` or fails a `[REQ]`, say so before
   writing code, and either change the proposal or amend this document. Silently building
   something that contradicts a clause here is the failure mode this file exists to prevent.
2. **Temporary means temporary.** Every `[TEMP]` clause carries a removal trigger. A `[TEMP]`
   with no trigger is a defect in this document.
3. **Amendments are explicit.** Changing a `[DEC]` requires an entry in section 18 stating
   what changed, when, and why. Decisions are allowed to change. Drifting away from them
   without saying so is not.

### Tag legend

| Tag | Meaning |
|---|---|
| `[REQ]` | **Production requirement.** Must be true before real users and real money touch the system. Non negotiable. |
| `[DEC]` | **Architectural decision.** Decided now and binding. Changing it requires an amendment in section 18. |
| `[TEMP]` | **Temporary development or mock behaviour.** Acceptable today, carries an explicit removal trigger. Must never become load bearing. |
| `[FUT]` | **Future consideration.** Deliberately not decided yet. Recorded so it is not forgotten and so today's design does not foreclose it. |

### Contents

1. Target architecture
2. Multi-tenancy and company configuration
3. Boundaries between backend, frontend and contracts
4. Database principles
5. Authentication
6. Authorization
7. Auditability
8. Inventory principles
9. Accounting principles
10. Concurrency
11. Idempotency
12. Document lifecycle
13. Testing
14. Security
15. Infrastructure and deployment
16. Current state: what is temporary, and what must never be faked
17. First vertical slice
18. Open questions and amendment log

---

## 1. Target architecture

### 1.1 Shape

`[DEC]` The system is a server authoritative web application. A single backend owns the
domain, the data and every business rule. Clients render a view of what their session is
permitted to see, and request operations that the backend validates, authorizes, performs
and records.

`[DEC]` The repository becomes a monorepo with three units:

```
apps/api            backend: domain, business rules, persistence, authorization, audit
apps/web            the existing React application, re-pointed at the API
packages/contracts  request and response schemas, generated client types, shared enums
```

The existing frontend is an asset, not a prototype to discard. It already treats every read
as asynchronous, handles loading, empty and error states, and renders behind permission
checks. Re-pointing its service layer at HTTP is a contained change and is the intended path.

### 1.2 Stack

`[DEC]` PostgreSQL is the single datastore for business data. The reasons are specific and
not preference: real transactions, deferred constraints for the journal balance invariant,
exact numeric types for money and quantity, JSONB for structured audit diffs, and row level
security available if it is ever wanted.

`[DEC]` The backend is TypeScript. The deciding factor is that a shared contracts package
between an already strict TypeScript frontend and the backend removes the entire class of
bugs where the two sides disagree about a shape. In a financial system that class of bug
produces wrong numbers rather than crashes, which is worse.

`[DEC]` Schema and migrations are owned by a migration tool with versioned, reviewed,
forward only migration files. Migrations are never generated implicitly at application start.

`[DEC]` *Ratified 2026-09-10. Final ruling on migration tooling.* Migrations are handwritten SQL
files, versioned and committed, applied by a small runner built on the existing `pg` dependency.
`drizzle-orm` is retained for typed schema definitions and application queries. `drizzle-kit` is
not used.

Two reasons, and the second matters more than the first.

The immediate one is that `drizzle-kit` depends on the deprecated `@esbuild-kit` packages, which
carry four moderate advisories that npm overrides cannot resolve in this workspace. Sections 14.8
and 14.9 require the audit to pass without suppression, and the precedent set with the Express
adapter is to remove a dependency path rather than whitelist it.

The structural one is that this schema needs things a schema DSL cannot express. Role creation,
`GRANT` and `REVOKE`, row level security policies, check constraints with domain specific
predicates, deferred constraints, and composite foreign keys that pin a child row to its parent's
tenant. Most of every migration here would be handwritten SQL regardless, so generating the
remainder buys little and costs a tool that must be kept clean.

`[REQ]` The cost of this choice is drift between the SQL and the Drizzle definitions, and it is
paid for by a test rather than by discipline. The schema verification required by criterion 28
compares the **running** database against the Drizzle definitions, not against the migration
source, so a hand edit to either side that the other does not match fails the build. Generation
would not have caught this either, since a generated migration can still be hand edited after.

`[REQ]` Migrations are forward only. An applied migration is never edited. The runner records a
checksum per migration and refuses to start if a previously applied file has changed, so an edit
that would have silently diverged environments becomes a failed deployment instead.

`[REQ]` The runner connects as the owning role, never the application role, per section 7.1. It
is a separate gated step and never runs at application start, per section 15.4.

`[DEC]` *Ratified 2026-09-09.* The stack is React with TypeScript and Vite on the client,
NestJS with TypeScript on the server, PostgreSQL for data, and Drizzle for schema, migrations
and queries.

NestJS earns its place here rather than a lighter framework because this system has cross
cutting concerns on nearly every request: tenant and company resolution, authorization at four
levels, transaction management, idempotency, and audit. Those are exactly what guards,
interceptors and injected request scoped context are for. A thinner framework would mean
building the same machinery by hand and relying on every route to remember to call it.

Drizzle earns its place because this system needs SQL it can see. Explicit row locks, deferred
constraints, common table expressions for ledger queries, and row level security policies are
all first class concerns here, and a query builder that stays close to SQL serves them better
than an abstraction that hides them.

`[DEC]` *Ratified 2026-09-09.* The NestJS HTTP adapter is Fastify, not Express. The reason is
the dependency audit required by sections 14.8 and 15.4: the Express platform package depends
on multer, which carries unpatched high severity advisories that npm overrides did not resolve,
and the product has no upload surface to justify carrying it. Removing the dependency path was
preferred over suppressing the finding. Fastify binds only to the interface it is given, so the
API takes a `HOST` setting defaulting to loopback, and a container must set it explicitly.

`[DEC]` Redis is introduced only where it earns its place, and not in slice 1. The likely uses
are rate limiting counters, background job queues, and caching. Sessions stay in PostgreSQL
until measurement shows a reason to move them, because a session store that can be queried and
joined alongside users and audit records is easier to operate and to reason about.

`[FUT]` Moving sessions to Redis, which section 5.1 already anticipates.

### 1.3 Contract first

`[DEC]` Request and response schemas are defined once on the server, an OpenAPI document is
generated from them, and the client types are generated from that. Neither side hand writes
the other's types.

`[REQ]` A schema change that breaks the client fails the build, not production.

### 1.4 What this architecture is not

*Amended 2026-09-09. The original text said the system was being built for one business. That
is no longer true; see section 2.*

`[DEC]` The system is configuration driven within a fixed schema. Each company configures the
domains listed in section 2.9 through the administration UI, and that configuration is data.

`[DEC]` It is not a metadata driven platform. Odoo and ERPNext let a customer add a field, a
doctype or a workflow without a code change, which is a much larger commitment: it means user
defined schema, a form renderer driven by metadata, and migrations that cannot assume the shape
of a table. We are not building that. A customer who needs a field the product does not have
gets it in a release, not by creating it themselves.

The distinction to hold onto: **configurable within a schema we control**, not **extensible into
a schema they control**.

`[FUT]` Customer defined custom fields on core documents. This is the most likely first request
that this decision refuses, and it is worth revisiting once several customers are live and the
pattern of their requests is known, rather than guessing now.

---

## 2. Multi-tenancy and company configuration

This section was added on 2026-09-09 when the product goal was confirmed. It is the defining
characteristic of the system and it constrains almost every other section. Where it conflicts
with an earlier clause, this section wins and the earlier clause has been amended.

### 2.1 The product shape

`[REQ]` This is one product, operated as one deployment, serving many independent companies
that do not know about each other. Tenant isolation is a core production requirement, not a
future consideration.

`[REQ]` A company configures its own environment through an administration interface. Adding a
customer, a warehouse, a role or a numbering rule is data entry, never a source code change and
never a deployment.

### 2.2 Two words that must not be confused

The reference systems separate two concepts that are easy to blur, and we adopt the same
separation.

| Concept | Meaning here |
|---|---|
| **Tenant** | An independent customer of the product. Complete isolation. No user, document or configuration is ever shared or visible across tenants. |
| **Company** | A legal entity inside a tenant. A single customer may run two trading entities that share a user directory and possibly a product catalogue. |

`[DEC]` The system models both. For the first release a tenant contains exactly one company,
and the schema carries both identifiers from the first migration, so that a customer acquiring a
second entity is a configuration change rather than a migration.

`[FUT]` Intercompany transactions, consolidated reporting and shared master data between
companies inside one tenant. Recorded now because the identifiers exist; not built until asked.

### 2.3 The eight layers, and where each one lives

`[REQ]` These are distinct and must never collapse into each other. Collapsing capability into
configuration is how a customer ends up able to grant a permission the code does not implement.
Collapsing identity into membership is how a user becomes unable to belong to two companies.

| # | Layer | Where it lives | Who changes it |
|---|---|---|---|
| 1 | Application capability | Code. A fixed catalogue of permission strings compiled into the build. | Developers, through a release |
| 2 | Company configuration | Data, scoped to a company. | A company administrator, through the admin UI |
| 3 | User identity | Data, global to the deployment. One person, one account, one credential. | The user, and platform support |
| 4 | Roles | Data, scoped to a company. Named bundles of capabilities. | A company administrator |
| 5 | Permissions held | Derived. The union of capabilities granted by the user's roles in the active company. | Nobody directly. It is computed. |
| 6 | Allowed companies | Data. Membership rows linking a user to the companies they may enter. | A company administrator, within their own company only |
| 7 | Active company | Session state, server side. Exactly one at a time. | The user, by an explicit switch validated against membership |
| 8 | Data scope | Data. Warehouse, branch and location restrictions attached to a membership. | A company administrator |

`[REQ]` Layer 1 is the ceiling for layer 4. A company administrator composes roles only from
capabilities the code implements. There is no mechanism by which configuration invents a
permission.

### 2.4 Tenant isolation strategy

`[DEC]` *Ratified 2026-09-09, closing open question 5.* A shared schema, with `tenant_id` and
`company_id` on every business table, mandatory scoping in the data access layer, and PostgreSQL
row level security as a second, database enforced layer.

`[REQ]` Row level security does not replace application scoping. It is the second of two layers,
and neither is permitted to stand alone. The full path is: request, server side session, tenant
and company context, scoped repository, query, row level security policy, data. The repository
layer is what makes an unscoped query unconstructible; row level security is what catches the
case where that failed. A change that removes either layer, on the grounds that the other one
covers it, contradicts this clause.

`[REQ]` The application connects as a role that row level security applies to. A role with
`BYPASSRLS`, or a table owner, is exempt from its own policies, so the second layer would be
silently absent. Migrations run as a different role from the application, per section 7.1.

*Added 2026-09-09, ruling on how policies learn the current tenant.*

`[DEC]` The tenant and company context reaches the database as transaction local settings, set
with `SET LOCAL` at the start of the transaction from the values resolved out of the session.
Policies compare against those settings. Nothing about the context is ever taken from a
statement the client influenced.

`[REQ]` **Every scoped query runs inside a transaction.** This follows from the mechanism and is
not optional: `SET LOCAL` outside a transaction does nothing, the setting would then be empty,
and a policy comparing against an empty setting fails open unless it is written to refuse. Two
consequences that must both hold:

- The policy treats a missing or empty context as denying everything, never as matching
  everything. This is the difference between a bug that returns nothing and a bug that returns
  another customer's ledger.
- A connection is never shared between requests mid-transaction, so context cannot leak from one
  actor to the next. The pool must be used per transaction, not per process.

`[REQ]` A test proves the failure mode directly: a query issued with no context set returns zero
rows rather than all rows. Section 14.9 requires the absence of a control to be tested, and this
is the case where getting it backwards is worst.

*Amended 2026-09-10, adding a third setting alongside the tenant and company ones.*

`[REQ]` The acting person also reaches the database as a transaction local setting. It is set
from the same session-derived scope, it is empty for operations that have no person behind them,
and an empty value denies exactly as an empty tenant does.

It exists because the first question company context has to answer, which companies may this
person enter, is cross-tenant by construction. Section 2.6 lets one person belong to companies in
more than one tenant, so the answer cannot come from inside a tenant, and the tenant is what is
not yet known. Exactly one policy uses this setting: a person may read their own membership rows
when no tenant context is set. It admits nothing else, to nobody else, and it is inert whenever a
tenant context is present.

`[REQ]` The person setting never widens a tenant scoped read. Any policy written against it must
require the tenant context to be empty, so that it can only ever answer a question a tenant
scoped context could not have been asked.

The three options and their real trade-offs:

| Option | Isolation | Cost |
|---|---|---|
| Shared schema, tenant column | Logical. A scoping bug can leak across tenants. | One migration run. Cheapest onboarding. Easiest cross-tenant operations. |
| Schema per tenant | Stronger. Cross-tenant queries are impossible by accident. | Migrations multiply. Connection and catalogue pressure at a few hundred tenants. |
| Database per tenant | Strongest. Per tenant backup, restore and data residency become trivial. | Every migration runs N times. Operational complexity grows with every customer. |

**What the reference systems actually do, and why it differs.** Frappe and ERPNext implement
multi-tenancy as a site per tenant, each with its own database, sharing only the application
code. Odoo distributes the same way, one database per customer. Both use their Company concept
only for multiple legal entities inside a single customer's database. Their model follows from
their distribution model: both are self-hostable products where a customer frequently runs their
own instance, so a database boundary per customer is the natural unit.

We are choosing differently because we operate the deployment rather than shipping it. A shared
schema gives one migration to run, one place to fix a bug, and onboarding that costs a row
rather than a provisioning job. The price is that isolation becomes a property of our code
rather than of the database, which is precisely why row level security is part of the
recommendation and not an optional extra.

`[REQ]` Whichever option is approved, the isolation boundary must be enforced below the
application layer as well as inside it. Defence in depth is not negotiable when the data is
other companies' books.

### 2.5 Company context is resolved server side

`[REQ]` The active company is held in the server side session. It is never read from a request
body, a query parameter, a path segment, a client supplied header, or any frontend state.

`[REQ]` Switching company is an explicit authenticated operation. The server verifies the target
company against the user's membership rows, updates the session, writes an audit record, and
only then serves data from the new company.

*Expanded 2026-09-10, when the increment that implements this found the sequence underspecified.*

`[REQ]` A session has two states, and both are legitimate. Authenticated with no company, which
is where every session begins, and authenticated inside one company. The first can read identity
and the person's own memberships. It can read no company's data, because it names no company for
row level security to compare against.

`[REQ]` The switch verifies membership twice, and the second time is the one that counts. The
first read discovers which tenant the target company belongs to, because a company identifier
alone does not say. The second runs inside the transaction that writes the change, in the scope
of the target company, and the write is refused if it finds no active membership. Without the
second check, a membership revoked between the two reads would still be honoured by a request
already in flight.

`[REQ]` The session records only the company. The tenant is derived from the membership on every
request rather than stored beside it, so a stale tenant on a session cannot outlive the
membership that justified it.

`[REQ]` A session whose active company no longer has a matching active membership is treated as
having no company, not as an error and not as its previous company. Access ends when membership
ends, without waiting for the session to expire.

`[REQ]` Every scoped query filters by the tenant and company resolved from the session. A query
that could return rows from outside them must not be constructible through the data layer's
public interface.

`[REQ]` Company context is never inferred from the network the user is on. Users work from
offices, homes and customer sites. Network origin is at most an additional restriction a
customer may opt into later, and never an identity signal.

`[FUT]` Per company network policies such as address allow lists, as an enterprise security
option layered on top of, never instead of, session based context.

### 2.6 Identity model

`[DEC]` User accounts are global to the deployment. One person has one account and one
credential, and reaches every company they are a member of through it.

`[DEC]` Membership is a separate record linking a user to a company, carrying that user's roles
and data scope within it. Membership is the unit a company administrator manages.

`[REQ]` A user with no membership in the active company has no access to it, regardless of any
role they hold elsewhere. Roles do not travel between companies.

`[REQ]` Email addresses are unique across the deployment, because they identify the credential
rather than the membership.

The alternative, an account per company, was rejected because it forces a person who works for
two of our customers, such as an external accountant, to hold two credentials, and it makes
credential compromise harder to reason about rather than easier.

### 2.7 Roles are per company, capabilities are not

`[DEC]` The permission catalogue is code. Roles are data owned by each company.

`[REQ]` When a company is created, a set of default role templates is seeded into it, matching
the sales, purchasing, warehouse, accountant, manager and administrator shapes the product
already models. From that moment they are the company's own, and editing them affects nobody
else.

`[REQ]` A company administrator may only grant capabilities from the catalogue, and may never
grant a capability they do not themselves hold. This is the privilege escalation rule from
section 6.6, applied inside the tenant boundary.

*Added 2026-09-09, ruling on how the catalogue is stored.*

`[DEC]` A granted capability is stored as its permission string, validated against the compiled
catalogue on write. There is no `permissions` table. A seeded table with a foreign key would
give referential integrity at the cost of a second source of truth for something the code
already defines, which section 1.4 and the no-duplication rule both refuse.

`[REQ]` Two checks replace the foreign key, and both are required because they catch different
failures. On write, a permission absent from the catalogue is rejected, so configuration cannot
invent a capability. At startup, every stored permission is checked against the catalogue and a
mismatch fails loudly, so a capability removed in a release surfaces immediately instead of
silently granting nothing to whoever still holds it.

### 2.8 Platform administration is not company administration

`[DEC]` Two distinct administrative planes, deliberately separated.

**Company administration** manages one company: its users, roles, warehouses, numbering, fiscal
settings and security policies. It is the surface described in section 2.9. It can never see
another company.

**Platform administration** creates tenants, supports customers and operates the deployment. It
is a separate authority, held by employees of the product rather than of the customer.

`[REQ]` Any cross tenant access by platform administration is a distinct, named capability. It
is time bounded, it is audited as a first class event, and the audit record names the tenant
whose data was accessed. Support access to a customer's books is among the highest risk
operations in the system and is treated that way.

`[REQ]` A company administrator can never escalate into platform administration. They are
different authorities, not different levels of the same one.

### 2.9 What a company configures

`[REQ]` The following are configuration data, held per company, edited through the
administration UI, and never a code change:

- company profile, legal identity, addresses and base currency
- fiscal settings: financial year, accounting periods, tax registration
- document numbering: series, format, reset behaviour, and whether a series is gapless
- users, invitations, deactivation, and membership
- roles, and the capabilities each one grants
- permission policies: approval thresholds and segregation of duties rules
- organisation: warehouses, branches and locations
- security policies: multi factor requirements, and any policy applied after a company is
  resolved. Authentication-time policy, meaning session lifetime, password rules and login
  throttling, is deployment level configuration; see section 5.3.
- chart of accounts, and the accounts that document postings map to

`[DEC]` Configuration is validated against the same rules as any other write. A company cannot
configure itself into an invalid state, for example a numbering series that would produce
duplicates, or a fiscal year that overlaps another.

### 2.10 What must never happen

`[REQ]` These are the negative requirements the system is measured against. Each one has a test
in section 13.

- Changing an identifier in a URL, a request body or client state must never return another
  company's data. The response is the same as for a record that does not exist.
- A user must never see, in any list, aggregate, count, report, export, search result or error
  message, data belonging to a company they are not a member of.
- A company administrator must never affect another company's users, roles or configuration.
- A permission granted in one company must never take effect in another.
- An error message, stack trace or log line must never disclose the existence of another tenant.

`[REQ]` Cross tenant leakage is the highest severity class of defect in this system. A single
occurrence is a breach of every customer's trust simultaneously, not a bug in one customer's
account.

---

## 3. Boundaries between backend, frontend and contracts

### 3.1 The backend owns

`[REQ]` Without exception, the backend owns:

- the domain model and all business rules
- all validation that has consequences
- all authorization decisions
- all persistence and all transactions
- every aggregate and total presented as authoritative
- document number allocation
- posting to the stock ledger and the general ledger
- audit record generation
- the meaning of "now" for anything with a business consequence

### 3.2 The frontend owns

`[REQ]` The frontend owns rendering, navigation, input collection, presentation formatting,
and client side validation for responsiveness only. Every client side validation rule must be
duplicated server side, and the server rule is the real one.

### 3.3 Rules at the boundary

`[REQ]` The frontend never computes a business figure presented as authoritative. Totals over
a filtered set come from the server, computed over the whole set, never summed from a page of
rows.

`[REQ]` The frontend never decides authorization. A permission check decides what to render
and nothing else. Every operation is authorized again server side on every request.

`[REQ]` The frontend never generates an identifier with business meaning. Document numbers
are allocated by the server inside the transaction that creates the document.

`[REQ]` The frontend is never trusted with prices, discounts, tax rates or costs sent back
from a form. The server recomputes every monetary figure from its own master data and the
submitted quantities, and rejects the request if the client's arithmetic disagrees beyond a
stated rounding tolerance.

### 3.4 Two type families, deliberately different

`[DEC]` Persistence models and read models are different shapes and are not unified.

Persistence models are normalised: a stock movement row stores a product id, not a product
name. Read models are denormalised for display and are what the API returns. The current
`src/domain` types are read models, and after the split they live in `packages/contracts` as
API contracts rather than being described as the persistence specification.

`[REQ]` Denormalised text on a persisted row is permitted only where it is a legal snapshot
of a past agreement. An invoice line description is frozen correctly, because it records what
the customer was billed for. A product name on a stock movement is a cache, it goes stale on
rename, and it belongs in the read model instead.

`[TEMP]` `src/domain` currently serves as both the specification and the frontend's types.
**Removal trigger:** the monorepo split, at which point it becomes a consumer of
`packages/contracts` and the server owns the persistence schema.

---

## 4. Database principles

### 4.1 Integrity lives in the database

`[DEC]` An invariant enforced only in application code is not enforced. Application code can
be bypassed by a migration script, a maintenance task, a background job or an administrator
at a database prompt. Constraints cannot.

`[REQ]` The following are enforced by database constraints or triggers, not only by services:

| Invariant | Mechanism |
|---|---|
| A journal entry's debits equal its credits | deferred constraint or trigger, evaluated per entry at commit |
| Sum of payment allocations never exceeds the payment amount | constraint or trigger |
| An invoice's paid amount never exceeds its total | check constraint |
| Posted journal entries are never updated or deleted | trigger, or revoked grants |
| Stock balance never negative where policy forbids it | check on the maintained balance row |
| Every foreign key relationship | actual foreign keys, always |
| Document numbers unique per company, type and sequence | unique index |

### 4.2 Every business table

`[REQ]` Every business table carries at minimum:

```
id             primary key
tenant_id      tenant scope, see 4.6
company_id     legal entity scope, see 4.6
created_at     timestamptz
created_by     user id
updated_at     timestamptz
updated_by     user id
```

*Amended 2026-09-10. `version` was previously listed above without qualification, which the
first migration could not satisfy for three tables where the column would have had no reader.*

`[REQ]` **Mutable** tables additionally carry `version integer`, for the optimistic locking in
section 10.1. A table is mutable when a row can be updated after it is written, which is the
only circumstance in which a lost update is possible.

`[REQ]` Four shapes are exempt, and the exemption is by reason rather than by name, so a table
added later inherits it only if the same reasoning applies:

| Shape | Why no `version` |
|---|---|
| Association tables, insert and delete only | A row is created or removed, never edited, so there is no update to lose. Adding a column to hold a number nobody increments invites a future contributor to trust it. |
| Append-only tables | Rows are never updated at all. `audit_events` goes further: section 7.1 revokes `UPDATE` and `DELETE` from the application role, so an update is refused by the database before optimistic locking could apply. |
| Tables where `updated_at` never changes | Same argument, stated generally. |
| **Ephemeral operational state where last write wins is the explicit concurrency model** | Added 2026-09-10. See the conditions below. `sessions` is the current and only example. |

**The fourth shape, deliberately narrow.** `sessions.last_seen_at` is refreshed by nearly every
request, and two parallel requests from one user updating it are both correct. Optimistic locking
would turn ordinary concurrent traffic into `409 Conflict` responses that mean nothing to the
user and describe no real conflict.

`[REQ]` A table qualifies for the fourth exemption only if **all four** of these hold. Any one of
them failing puts the table back under the main rule:

1. It holds operational state, not a business record. Nothing in it appears on a document, in a
   ledger, in a report, or in an audit trail as business content.
2. It is ephemeral. Rows are expected to expire, be revoked, or be cleaned up, and losing one
   costs a user a re-login rather than a transaction.
3. Last write wins is the **chosen** concurrency model, written down at the table, not the
   accidental result of nobody having thought about it.
4. No field in it is edited by two different actors with different intent. Concurrent writers are
   the same principal doing the same thing.

`[REQ]` The exemption does not weaken the main rule. A mutable business table requires `version`,
and "concurrent conflicts would be inconvenient" is not a reason to drop it: for business data
that inconvenience is the control working. Claiming this exemption for a table that carries
business meaning is a defect, and reviewers should read the four conditions above as a checklist
rather than a description.

`[REQ]` A mutable table without `version` is a defect. An exempt table with an unused `version`
is also a defect, because a column that looks like a concurrency control and is never checked is
worse than an absent one.

`[DEC]` Primary keys are UUIDv7. They are non sequential, so identifiers are not trivially
enumerable, and they can be generated before insert, which simplifies linking within a
transaction. Stated explicitly: **unguessable identifiers are not access control**. Scoping
per section 6.3 is the access control.

### 4.3 Money

`[DEC]` Money is stored as exact numeric, never floating point, never a plain integer of
minor units.

```
amounts       NUMERIC(19,4)
unit prices   NUMERIC(19,6)
currency      char(3), stored alongside every amount
```

The reason for split precision is concrete to this business. A distributor sells cable ties
at a fraction of a cent per unit inside a pack of one thousand, and buys at four or more
decimal places from a supplier price list. Two decimal places on unit prices, which is what
the current frontend model assumes, loses money on the first real price list. ERPNext and
Business Central both carry higher precision on unit prices than on document totals for this
exact reason.

`[DEC]` Money crosses the API as a decimal string plus a currency code, for example
`{ "amount": "1234.5600", "currency": "USD" }`. JSON numbers are IEEE-754 doubles and will
silently lose precision. The frontend parses to a decimal type at the boundary and never uses
a JavaScript `number` for money.

`[REQ]` Rounding is explicit, stated per operation, and applied at defined points only. Any
rounding difference on a document is allocated to a stated line rather than silently absorbed.

`[TEMP]` The frontend currently models money as integer minor units at two decimal places in
`lib/money.ts`. **Removal trigger:** adoption of the contracts package. This is a required
migration, not an optional cleanup.

### 4.4 Quantities

`[DEC]` Quantities are `NUMERIC(19,6)`. Distribution sells fractional kilograms and metres,
and unit of measure conversion produces non integer intermediate values.

### 4.5 Documents are never deleted

`[REQ]` Business documents are cancelled, reversed or archived. They are never hard deleted.
Auditors and tax authorities need the mistake and the correction both visible.

`[REQ]` Deletion is permitted only for records with no business consequence, for example a
draft that was never confirmed, and even then it is recorded in the audit log.

### 4.6 Tenant and company scope

*Amended 2026-09-09. This was previously an assumption pending an open question. The product
goal is now confirmed, so it is a requirement.*

*Amended again 2026-09-09. The original wording said every business table without exception,
which the global identity tables cannot satisfy. The exception is now named and closed rather
than discovered per table.*

`[REQ]` Every **tenant-scoped** table carries `tenant_id` and `company_id` from the first
migration, and every query against it is scoped by both. See section 2.4 for the isolation
strategy and section 2.2 for why the two identifiers are distinct.

`[REQ]` On a tenant-scoped table the scope columns are not nullable, and they are the leading
columns of the indexes that serve list queries, so that scoping is cheap rather than an
afterthought filter.

`[REQ]` No tenant-scoped table is reachable by a query that does not constrain both columns.
Section 6.3 describes the mechanism; this clause states the invariant.

**The global tables, which is a closed list.** These sit outside the tenant boundary because
section 2.6 ratified one account per person reaching every company they belong to. Forcing scope
columns onto them would mean a user row per tenant, which is the model that ruling rejected.

| Table | Why it is global |
|---|---|
| `tenants` | It is the boundary. It cannot be inside itself. |
| `users` | One person, one account, one credential, per section 2.6 |
| `sessions` | Belongs to a global user. Carries the active company as state rather than as scope. |
| `auth_throttle` | Added 2026-09-10. Authentication precedes tenant resolution. See below. |

*`auth_throttle` added 2026-09-10, following the amendment procedure this section requires.*

**Why `auth_throttle` is necessarily global.** Section 5.2 requires login to be rate limited per
address and per account. Both measurements happen before any tenant is known, and the per-address
case is sharper still: an attempt against an address matching no account has no user row and no
tenant to attribute it to, which is exactly the attempt a per-address limit exists to catch. A
tenant column here could only ever be null.

Two alternatives were examined and rejected. Counters on `users` cover the per-account case and
cannot cover the per-address one. Deriving the counts from `audit_events` fails for a different
reason: an audit row is written once and never revised, so a counter derived from it would be a
scan of every prior attempt rather than a single locked row, and the atomic upsert that makes the
limiter unbypassable under concurrency has nowhere to happen.

*Corrected 2026-09-10. This paragraph previously said the application could write authentication
audit rows and never read one back. The second half was right and the first half was wrong: the
select policy also governed the `RETURNING` clause of the insert, so those rows could not be
written either. See the ruling in section 7.3.*

`[REQ]` `auth_throttle` holds only authentication throttling state: a scope kind, a scope key, a
counter, a window, and a lock expiry. It carries no business data and is never joined to a
tenant-scoped table. If a future change would put anything else in it, that change needs its own
amendment.

*Corrected 2026-09-10. This clause first said the table carried no personal data beyond the
address. It carries more than that, and the correction is recorded rather than quietly made.*

`[REQ]` The scope key holds a client address for the address dimension and the lowercased
attempted email for the account dimension. An attempted email is personal data whether or not it
matches an account, so this table is in scope for retention and erasure obligations. Section 5.2
requires the per-account dimension, and it cannot be counted without naming what was attempted.

`[FUT]` A reaper that deletes rows whose window and lockout have both elapsed. Not built. Until
it exists, a row survives its own usefulness, which is a retention question rather than a
security one. A stale row grants nothing: an elapsed lock is reported as no lock, and an elapsed
window restarts the count on the next failure.

`[REQ]` This is not an infrastructure exemption and must not be cited as precedent for one. The
clause below refuses the "it is not really tenant data" argument, and that refusal stands. The
exemption here rests on a narrower fact: this table is written before a tenant exists to scope it
to, which is true of nothing else in the system except authentication itself.

`[REQ]` This list is closed. A new global table requires an amendment naming it here and saying
why scope cannot apply, because "it is not really tenant data" is the reasoning behind every
cross-tenant leak. Reference tables that are genuinely universal, meaning currency codes and
country codes, remain a separate exception and are read only to the application.

`[REQ]` A global table is not unprotected. `users` and `sessions` are reachable only through the
authenticated actor's own identity, never by listing, and never by an identifier supplied by a
client. Absence of a tenant column is not absence of authorization.

### 4.7 Indexing and growth

`[REQ]` Every foreign key is indexed. Every list screen's default sort and its common filter
combinations are covered by an index, verified against query plans rather than assumed.

`[REQ]` Partial indexes for the open document queries, which are the ones users run all day:
unpaid invoices, unapproved orders, unreceived purchase orders.

`[FUT]` Partitioning the stock ledger and journal line tables by accounting period once
volume justifies it. The schema should not make this harder than necessary.

`[FUT]` A read replica for reporting, so a heavy month end report cannot degrade order entry.

---

## 5. Authentication

### 5.1 Mechanism

`[DEC]` Server side sessions. The client receives an opaque session identifier in a cookie
with `HttpOnly`, `Secure` and `SameSite=Lax`. The session record lives in PostgreSQL.

`[DEC]` Not a JWT in local storage. Two reasons, both operational. An ERP must be able to
terminate a session immediately when someone is dismissed or a credential is suspected
compromised, and a stateless token cannot be revoked without building the server side state
that a session already is. Second, a token readable by JavaScript is a token stealable by a
single cross site scripting flaw, whereas an `HttpOnly` cookie is not.

`[FUT]` Moving the session store to Redis when volume or latency justifies it. The session
interface should not assume PostgreSQL specifics.

### 5.2 Credentials

`[REQ]` Passwords hashed with argon2id, with parameters recorded in configuration and
reviewed periodically.

`[REQ]` Password change or reset invalidates all other sessions for that user.

`[REQ]` Login failures return a single generic message. The response must not reveal whether
the email exists, and neither must the timing.

`[REQ]` Login is rate limited per address and per account, with progressive backoff and
lockout, and every failure is recorded.

### 5.3 Session lifetime

`[REQ]` Sessions carry both an idle timeout and an absolute maximum lifetime. Both are
configuration, both are enforced server side, and expiry is checked on every request rather
than trusted from a cookie attribute.

`[REQ]` The session identifier is rotated on login and on any privilege change.

`[REQ]` Logout invalidates the session server side. A replayed cookie after logout is
rejected.

*Added 2026-09-10, resolving a contradiction found while implementing authentication.*

`[DEC]` **Authentication-time policy is deployment level configuration, not per-company.** That
covers session idle and absolute lifetime, password rules, and login throttling thresholds.

Section 2.9 lists security policies among the domains a company configures. Taken literally that
is impossible for these three, because authentication happens before any company is known: at the
moment a password is checked and a session is created, there is no company whose policy could
apply. The two clauses could not both hold as written, so this one settles it for the
authentication path and section 2.9 now points here.

`[REQ]` The values are validated at startup alongside the rest of the configuration, per section
15.2, so a malformed security setting fails the boot rather than the first login.

`[FUT]` Per company overrides, applied after company context is resolved rather than at
authentication. A company could then shorten its own session lifetime or raise its own password
requirements, with the deployment value as the floor. This is deliberately not built now: it needs
company context, which belongs to a later increment, and building half of it would mean a policy
that applies to some sessions and not others depending on when it was read.

### 5.4 Identity is separate from authorization

`[DEC]` Authentication answers "who is this". Authorization answers "what may they do". They
are separate layers, and the user table carries an `external_subject_id` column from the
first migration so an external identity provider can be introduced without restructuring.

`[FUT]` Single sign on via OIDC. Pending the open question in section 18.1.

`[FUT]` Multi factor authentication, required for roles that can approve spending, post to
the ledger, or manage users.

### 5.5 What is temporary today

`[TEMP]` `app/session.tsx` imports the user list from `mocks/reference.ts` and selects an
identity from `localStorage`. The top bar role switcher is a review tool.
**Removal trigger:** slice 1. The session provider fetches `/me`, the mocks import is
deleted, and the switcher is either removed or gated behind a development flag that is
compiled out of production builds.

**This is production critical behaviour and must never be faked beyond slice 1.** A frontend
that chooses its own identity is not an authentication system, and no amount of backend work
later compensates for having built on it.

---

## 6. Authorization

### 6.1 Four dimensions

*Amended 2026-09-09. Tenant and company scope was added as the outermost dimension when the
product goal was confirmed.*

`[DEC]` Authorization has four dimensions, evaluated in this order, all enforced server side.
The current permission model covers only the third.

| Order | Dimension | Question | Example |
|---|---|---|---|
| 1 | Tenant and company | is the actor inside the boundary at all | a user with no membership in this company sees nothing |
| 2 | Row | which records inside that company may this user touch | a warehouse operator sees only their site |
| 3 | Operation | may this role perform this action | may a sales rep post an invoice |
| 4 | Field | which fields of a permitted record may they see | a warehouse operator sees the order but not its prices or the customer's credit limit |

The order matters. Company scope is evaluated first and is not a permission that a role can
grant. No capability, including company administration, reaches outside the boundary. The only
mechanism that crosses it is platform administration under section 2.8, which is a separate
authority rather than a stronger role.

`[REQ]` A failure at dimension 1 is indistinguishable from the record not existing. It returns
the same response as a genuine miss, so that identifiers cannot be probed to learn what other
companies hold.

### 6.2 Operation level

`[DEC]` Role based access control with `resource:action` permission strings, carried forward
from the existing model. The split between `create` and the state changing verbs `confirm`,
`approve` and `post` is retained, because that split is what encodes segregation of duties.

`[REQ]` Deny by default. Every route declares the permission it requires. A route that
declares none fails to register, and a test proves it.

`[REQ]` Effective permissions are computed server side from the user's roles and returned by
`/me` for display purposes only. The client never sends its own permissions, and the server
never reads a role from a request body or header.

### 6.3 Row level, and why it is enforced in the query

`[DEC]` Row level scoping is applied as a mandatory filter in the data access layer, not as a
check performed after loading a record by identifier.

This is the single most important security decision in the document. Broken object level
authorization is the most likely serious vulnerability in a system like this, and the two
approaches fail differently:

- Fetch by id, then check ownership. Correct only if every endpoint remembers. One forgotten
  endpoint out of two hundred is a data breach.
- Scope the query so out of scope rows cannot be returned. A forgotten endpoint returns
  nothing rather than someone else's data.

Odoo and ERPNext both take the second approach, and it is worth naming why. Odoo record rules
inject a domain filter into every query for the acting user, and ERPNext User Permissions do
the equivalent. Access is a constraint on what the query can return, not an inspection of
what it did return.

`[REQ]` Every repository method requires an actor context argument. Constructing an unscoped
query must not be possible through the public interface of the data layer. Background jobs
and migrations use an explicitly named system context, which is greppable and reviewable.

`[REQ]` `User.warehouseIds` becomes enforced scope rather than decoration. Today the field
exists, is populated for two fixture users, is rendered as a count on the admin screen, and
is enforced nowhere.

### 6.4 Field level

`[DEC]` Field level restriction is applied server side at serialisation. Data the user may
not see is never sent. Hiding a field in the UI while shipping it in the JSON response is not
a restriction, it is an inconvenience for the attacker.

ERPNext models this with permission levels on fields, which is a reasonable reference for how
granular this needs to be in practice.

### 6.5 Policy rules that are not permissions

`[REQ]` Two real controls in this business cannot be expressed as permission strings and are
implemented as policy data plus checks at transaction time:

- **Approval thresholds.** A manager may approve purchase orders up to a value limit; above
  it, escalation is required. The limit is configuration per role and per company, not a
  constant in code.
- **Segregation of duties.** The approver of a purchase order must not be its requester. The
  person who records a supplier bill must not be the one who releases its payment. Checked
  inside the transaction that performs the operation, because it depends on the record's own
  history rather than on the actor's role alone.

These two controls are among the main reasons a business buys an ERP at all. They are not
optional polish.

### 6.6 Privilege escalation

`[REQ]` A user may never grant themselves a permission they do not hold, nor assign a role
whose permission set exceeds their own. Role assignment is itself a permission, checked
against the granting user's effective permissions.

`[REQ]` Every role or permission change writes an audit record and invalidates or re-derives
the affected user's sessions. The chosen behaviour is stated in the implementation, not left
ambiguous.

### 6.7 What is temporary today

`[TEMP]` The application has no route level authorization. Navigation items are filtered by
permission, but every route renders for every role, so a warehouse operator reaches the
general ledger by typing its URL. **Removal trigger:** slice 1.

`[FUT]` Delegation and temporary authority, for example an approver's rights during leave.

`[FUT]` Approval chains that vary by warehouse, category or value band.

---

## 7. Auditability

### 7.1 Who writes it

`[REQ]` Audit records are written by the backend, inside the same database transaction as the
change they describe. A change can never exist without its audit record, and an audit record
can never exist without its change.

`[REQ]` The actor is taken from the authenticated session. Never from a request body, a
header, or any client supplied value.

`[REQ]` *Ratified 2026-09-09, closing open question 7.* The audit table is append only, enforced
by database grants: the application role holds `INSERT` and `SELECT` on it and nothing else. This
is a grant, not a convention, so that application code cannot revise history even by mistake. The
trigger alternative was rejected because a trigger is application adjacent logic that a superuser
or a migration can disable, whereas a missing grant is enforced by the database regardless of what
the connecting code attempts.

`[REQ]` This requires two database roles from the first migration: an owning role that runs
migrations and holds DDL rights, and a restricted application role that the API connects as. The
application role never owns a table, because an owner can always grant itself back what was
revoked. Local development and continuous integration both use the two role setup, so that a
grant mistake fails in development rather than in production.

`[REQ]` *Added 2026-09-10.* **Neither role is a superuser.** A superuser bypasses row level
security entirely, including on a table with `FORCE ROW LEVEL SECURITY`. An owning role that was
a superuser would therefore have every policy unenforced against it: seeded rows would skip
`WITH CHECK`, and any isolation test written against that role would pass whether the policies
worked or not. The owning role gets DDL rights by owning the database and schema, not by being a
superuser. A superuser account may exist to provision those two roles and is used for nothing
else.

This was found in practice rather than in review. A first pass at the isolation tests ran as the
provisioning superuser and reported that cross-tenant inserts succeeded, which looked like a
missing policy and was in fact a test that could never have failed.

### 7.2 Structured, not preformatted

`[DEC]` Field changes are stored as structured data: the field path, and typed old and new
values in JSONB. Not preformatted display strings.

The current model stores before and after as rendered text, for example a currency formatted
amount with a symbol. That freezes today's formatting choices into a permanent legal record,
makes the log unqueryable, and means a locale or currency display change silently rewrites how
history reads. Values are stored raw and rendered at display time.

### 7.3 What is captured

`[REQ]` Every audit record captures: actor id, the actor's role at the time, action, entity
type, entity id, company, occurred at, request id, IP address, user agent, and the database
transaction id.

The actor's role is captured as it was, not looked up later. Roles change, and an audit record
that reports today's role for last year's action is misleading.

*Amended 2026-09-09. Company cannot be present on every record, and pretending otherwise would
have made the authentication events unrecordable.*

`[REQ]` `tenant_id` and `company_id` are nullable on the audit table alone, because a failed
login happens before any company is known and criterion 18 requires it to be audited anyway.
The gap is narrowed by a check constraint rather than left open: they may be null only for the
authentication actions, and must be present for everything else. A missing company on a
document event is then a constraint violation, not a silent hole.

`[REQ]` The audit table is the only table permitted this exemption. It is granted because the
alternative is not auditing authentication, which is worse.

*Amended 2026-09-10, after the policy written for the clause above was found to block the writes
it was meant to permit.*

`[REQ]` A platform level audit row, meaning one whose `tenant_id` is null, is readable only in a
transaction that has no tenant context at all. A tenant scoped transaction sees its own rows and
no platform row; an empty context sees platform rows and no tenant's rows. Neither direction
crosses a tenant boundary and no context ever sees two tenants.

The original policy compared `tenant_id` to the current context and nothing else, on the reasoning
that authentication records belong to platform administration under section 2.8. That reasoning
was sound and the policy was not. PostgreSQL applies `SELECT` policies to the `RETURNING` clause of
an `INSERT`, and the audit repository returns the row it appends, so a platform row failed the
check and the whole insert was rejected. Every login, failed login and logout would have thrown,
and criterion 18 was unimplementable. `FORCE ROW LEVEL SECURITY` extended the same blindness to the
owning role, so nothing could read the rows either.

An empty tenant context exists only inside an explicitly named system scope under section 6.3.
That is the same context that already reads `users` and `sessions` in full, because section 4.6
makes them global, and a platform audit row carries less than either. The check constraint above
still confines platform rows to the four authentication actions, so this cannot become a route to
tenant business events with the scope left off.

`[FUT]` Platform administration as a product capability, including who may read these rows over
HTTP, remains section 2.8 and remains unbuilt. This clause governs which database transactions may
see them, not which people.

### 7.4 Two different logs

`[DEC]` The compliance audit log and the human activity feed are separate concerns with
separate retention, volume and audience, even where one event feeds both.

`[REQ]` The financial ledgers are themselves immutable records and are part of the audit
story. Posted journal entries and stock movements are never updated or deleted, only reversed
by a further entry.

### 7.5 What is temporary today

`[TEMP]` Audit events are generated by the fixture generator alongside the documents they
describe. **Removal trigger:** per module, when that module's writes become backend operations.

`[FUT]` Tamper evidence through hash chaining of audit rows.

`[FUT]` Shipping audit records to write once external storage for regulatory retention.

---

## 8. Inventory principles

### 8.1 The ledger is truth

`[DEC]` Stock is an append only ledger of immutable movement rows. There is no mutable
quantity field on a product. Every movement carries the document that caused it.

This is the existing model and it is correct. It is restated here because it is the single
easiest thing for a future contributor to undo under deadline pressure.

### 8.2 The projection is materialised

`[DEC]` A balance row per company, product and location is maintained in the same transaction
as the movement that changes it. The ledger remains the source of truth; the balance row is a
maintained aggregate, with a rebuild and verify job that recomputes it from the ledger and
reports drift.

Folding a few hundred movements per request works. Folding tens of millions does not. This is
what ERPNext does with its Bin records and Odoo with quants: an immutable ledger underneath, a
cached per item and location aggregate above it. The absolutist reading of "derived, never
stored" is right about truth and wrong about the read path.

`[REQ]` The rebuild and verify job runs on a schedule and alerts on any discrepancy between
the ledger and the maintained balance.

### 8.3 Quantity and value are separate ledgers

`[DEC]` Quantity movements and value entries are separate records linked to each other, after
the Business Central model of Item Ledger Entry and Value Entry.

The reason is that quantity and cost are known at different times. Goods arrive before the
supplier's bill does. Freight and duty land weeks later and belong to stock that may already
be sold. A landed cost or a cost correction must adjust valuation without rewriting quantity
history. Conflating the two is why the current fixture set has an inventory control account
and a stock valuation that differ by roughly three hundred and twenty one thousand.

### 8.4 Unit of measure

`[REQ]` Every product has a canonical stocking unit of measure. The stock ledger is always
recorded in the stocking unit. Documents may use a purchase or sales unit, and the conversion
factor used is recorded on the document line so that a later change to the conversion does not
alter history.

Buying in cases and selling in units is the defining operation of this business, and the seed
data already uses box and case units. This must exist before the first stock row is persisted,
or every quantity in history becomes ambiguous.

### 8.5 Reservation and availability

`[REQ]` Available equals on hand minus reserved. A salesperson is shown available, never on
hand.

`[REQ]` Confirming an order that would oversell fails inside the transaction, not after it.
See section 10.2 for the concurrency mechanism.

`[REQ]` Negative stock is a policy per warehouse, defaulting to deny.

### 8.6 Costing

`[REQ]` The costing method declared on a product is actually implemented. Today
`costingMethod: 'average'` is a label: receipts capitalise at purchase order cost, cost of
goods sold relieves at the product's static cost price, and valuation uses the same static
figure. Three bases in one flow.

`[DEC]` Moving average is implemented first, with the cost recalculated on each receipt inside
the receipt transaction. FIFO is a later addition and the value entry model in 8.3 is what
makes it addable without restructuring.

### 8.7 Future

`[FUT]` Virtual locations making goods double entry, in the Odoo model, so that quantities are
conserved rather than signed. `MovementReason` in the current model preserves what this
upgrade needs.

`[FUT]` Lot, batch and serial tracking, with expiry. Required if the catalogue ever includes
regulated or perishable goods.

`[FUT]` Landed costs.

`[FUT]` Multi step receipt and delivery routes, for example receive then inspect then stock.

`[FUT]` Stock transfers with in transit ownership. This is the one placeholder screen in the
current application, and it is unbuilt for the right reason: the workflow is genuinely
undefined, not merely unimplemented.

---

## 9. Accounting principles

### 9.1 Immutability and correction

`[REQ]` A posted journal entry is never edited or deleted. Corrections are reversing entries,
so the mistake and the fix are both visible.

`[REQ]` Every entry balances, enforced by a database constraint per section 4.1, not only by
application code.

### 9.2 No stored balances

`[REQ]` Account balances, customer balances and supplier balances are derived from the ledger.
No entity carries a stored balance column that is treated as a source of truth.

`[TEMP]` `mocks/reference.ts` seeds static `Account.balance` values that contradict the ledger.
The chart of accounts screen correctly ignores them, but the dashboard cash position reads
them, so the same figure differs between two screens: roughly two hundred and ninety eight
thousand on the dashboard against negative forty two thousand in the ledger.
**Removal trigger:** immediate, ahead of slice 1 if convenient, since it is a live
contradiction rather than a missing feature.

### 9.3 Opening balances are entries

`[REQ]` Opening balances are a posted journal entry like any other. The current fixtures
create seventy two opening stock movements with no corresponding entry, which is why the
ledger shows negative cash and an understated inventory account: the books have no opening
balance sheet at all.

### 9.4 Interim accounts bridge timing

`[DEC]` Goods received not invoiced, and goods delivered not invoiced, are held in interim
accounts.

Receipt and billing happen at different times, as do delivery and invoicing. Without interim
accounts the inventory control account only moves when the bill posts, which is exactly the
current defect. Odoo calls these stock interim accounts, and every system that does perpetual
inventory under this accounting model has an equivalent.

### 9.5 Control account reconciliation

`[REQ]` Control accounts reconcile with their subsidiary ledgers, checked automatically:

| Control account | Reconciles against |
|---|---|
| Accounts receivable | sum of open customer invoice balances |
| Accounts payable | sum of open supplier bill balances |
| Inventory | stock valuation from the value ledger |

`[REQ]` A legitimate difference must be explainable and documented. The current receivables
difference is a good example of a correct one: an unallocated customer receipt credits
receivables without being applied to an invoice. That is correct accounting and exactly why
unallocated cash must stay visible.

### 9.6 Periods

`[REQ]` Accounting periods can be closed, and a closed period rejects new postings. Enforced
inside the posting transaction, never by hiding a button.

### 9.7 Currency

`[REQ]` Every amount is stored in both transaction currency and company currency, with the
rate used recorded on the document at posting time. Settlement at a different rate produces a
realised foreign exchange gain or loss entry.

`[FUT]` Period end revaluation of open foreign currency balances.

`[FUT]` A tax engine beyond a single rate: jurisdictions, exemptions, and reverse charge for
cross border trade within the European Union, which the current fixture set implies.

`[FUT]` Analytical dimensions or cost centres.

`[FUT]` Profit and loss and balance sheet reports. The types exist; the service does not.

---

## 10. Concurrency

### 10.1 Optimistic locking for documents

`[REQ]` Every mutable document carries a `version` column. Update requests carry the version
the client read. A mismatch returns `409 Conflict` with enough information for the UI to tell
the user what changed. Two users editing the same draft order must not silently overwrite each
other.

`[REQ]` The frontend surfaces a conflict as a real, explained state, not a generic error.

### 10.2 Pessimistic locking for contended rows

`[REQ]` Rows that many transactions contend for are locked explicitly with `SELECT ... FOR
UPDATE` inside the transaction:

- stock balance rows, when reserving or moving stock
- document number sequence counters
- payment allocation against an invoice

The canonical failure this prevents: two salespeople confirming orders for the last ten units
at the same moment, both reading a balance of ten, both succeeding, and the warehouse
discovering the oversell at picking time.

`[REQ]` A lock acquisition order is documented and followed, so that deadlocks are designed out
rather than retried around.

### 10.3 Isolation

`[REQ]` The default isolation level is `READ COMMITTED`. Operations that read a value and then
write based on it, meaning reservation, allocation and posting, either take explicit row locks
or run at `SERIALIZABLE`. The choice is stated per operation in code, not left to the default.

`[REQ]` Serialization failures are retried at the API boundary with bounded backoff. This is
safe only because of idempotency per section 11.

### 10.4 Document numbering

`[DEC]` Number sequences are configurable per company and per document type, and the choice
between gapless and gap tolerant is a per sequence setting.

The distinction is legal, not technical. A database sequence is fast and lock free but leaves
gaps when a transaction rolls back. Invoice numbering in many jurisdictions must be gapless,
which forces a counter row locked inside the posting transaction, accepting the serialisation
cost. Business Central calls these No. Series and ERPNext calls them Naming Series; both treat
it as first class and configurable because it varies by country and by document type.

`[TEMP]` Document numbers are currently produced by an incrementing JavaScript counter in the
fixture generator. **Removal trigger:** the first backend document creation, in slice 2.

---

## 11. Idempotency

`[REQ]` Every state changing endpoint accepts an `Idempotency-Key` header. The server stores
the key, a fingerprint of the request, and the response, scoped by company, user and endpoint.
A replay with the same key returns the stored response without re-performing the operation. A
replay with the same key but a different request body is rejected as a conflict.

`[REQ]` The client generates one key per user intent, not per network retry. Pressing "Post
invoice" once produces one key, however many times the request is transmitted.

`[REQ]` State transitions are additionally guarded by their own current state, so that posting
an already posted invoice fails on the state machine even if the idempotency record has
expired.

`[DEC]` Idempotency records live in PostgreSQL with a bounded retention window, expired by a
scheduled job.

The reason this is a `[REQ]` and not a refinement: a network timeout during invoice posting,
retried by an impatient user or an automatic client retry, must not post twice. Duplicate
journal entries are far harder to unwind than a failed request.

---

## 12. Document lifecycle

### 12.1 States

`[DEC]` Each document type has its own status union. There is no global status enum. A sales
order's states are not an invoice's states, and flattening them produces statuses that are
meaningless for half the documents that carry them.

`[REQ]` Legal transitions are declared in an explicit transition table, enforced server side.
An illegal transition returns a domain error naming the current state and the attempted one,
not a generic failure.

### 12.2 The draft boundary

`[REQ]` A draft is editable and has no side effects: nothing reserved, nothing owed, nothing
posted. Confirming or posting is the irreversible moment, and it always does all of the
following in one transaction, or none of it:

1. validate against current master data and current state
2. authorize, including row scope and any policy rule such as segregation of duties
3. apply the side effects, meaning stock movements, ledger entries, reservations
4. allocate the document number
5. write the audit record
6. commit

`[REQ]` If any step fails, the whole operation fails. There is no partial post.

### 12.3 After posting

`[REQ]` A posted document is immutable. Correction is a new document that reverses it: a
credit note, a reversing journal entry, a return.

`[REQ]` Cancellation rules are explicit per document type, including whether cancelling
releases reserved stock and what accounting consequence it carries.

### 12.4 Relationships are edges

`[DEC]` Document relationships are stored in a link table with a typed relation, and the
related documents view is derived by query.

`[TEMP]` Documents currently carry a stored `links` array that the fixture generator
pre-populates, including downstream documents pushed backwards onto the parent.
**Removal trigger:** the first backend document module. A stored graph can drift from the
facts, which is the second source of truth problem this document forbids elsewhere.

`[TEMP]` `resolveDocumentRefs` in `services/sales.service.ts` is synchronous and reads the
in-memory fixture database during render. **Removal trigger:** the document links endpoint. It
is the one place the service seam is genuinely broken today.

---

## 13. Testing

### 13.1 What must be tested

`[REQ]` Unit tests for pure domain logic: money arithmetic and rounding, unit of measure
conversion, aging bucket boundaries, payment allocation, and every state transition table.

`[REQ]` Property based tests for the financial invariants. For any generated sequence of valid
business operations, the trial balance balances and control accounts reconcile with their
subsidiary ledgers. This is the highest value test in the system, because it catches modelling
errors that example based tests miss.

`[REQ]` An authorization matrix test, generated from the permission registry, covering every
registered route against every role with an expected allow or deny. A new route with no matrix
entry fails the build. This is the test suite that actually prevents broken access control.

`[REQ]` Integration tests against a real PostgreSQL instance, because the constraints are part
of the logic and a mocked database proves nothing about them.

`[REQ]` Concurrency tests that run the real races: two parallel confirmations of the last unit,
parallel number allocation, and an optimistic lock conflict.

`[REQ]` Migration tests: every migration runs forward against both an empty and a seeded
database in continuous integration.

### 13.2 What must not be done

`[DEC]` The database is never mocked in a test that asserts a business invariant.

`[REQ]` Tests do not assert against fixture data that the code under test also generates.

`[FUT]` End to end browser tests for the critical paths.

`[FUT]` Load testing, and failure injection against the posting paths.

---

## 14. Security

The system will eventually face real users, real money and real attackers. These are design
constraints, not a hardening pass at the end.

### 14.1 Broken access control

The highest risk in a system of this shape. Addressed by section 6.3 query level scoping,
section 6.2 deny by default, and the authorization matrix test in section 13.1. `[REQ]`

### 14.2 Injection

`[REQ]` Parameterised queries only. No SQL assembled by string concatenation, including in
reporting and in any future dynamic filter feature. All input parsed and validated against a
schema at the boundary, with unknown fields rejected rather than ignored.

### 14.3 Mass assignment

`[REQ]` Request bodies are never bound directly to persistence entities. Explicit mapping
only. Otherwise a crafted request sets `status`, `postedAt` or `companyId`.

### 14.4 Session and CSRF

`[REQ]` Session security per section 5. Because authentication uses cookies, every mutating
request additionally requires a custom header that a cross origin form cannot set, and the
origin is checked server side. `SameSite` alone is defence in depth, not the whole control.

### 14.5 Cross site scripting

`[REQ]` React's default escaping is relied on and `dangerouslySetInnerHTML` is prohibited
without a documented exception and sanitisation. A Content Security Policy is served, without
`unsafe-inline`.

### 14.6 File handling

`[REQ]` Attachments, meaning supplier invoices, delivery notes and proofs of delivery, are
stored outside the web root, typed by content inspection rather than by file extension, served
from a different origin than the application, and reached through short lived signed URLs
authorised per request. Uploaded files are size limited and scanned.

### 14.7 Rate limiting and abuse

`[REQ]` Rate limits per address and per authenticated user, stricter on authentication and on
expensive report endpoints.

`[REQ]` Business logic abuse is treated as a security concern with server side rules: negative
or zero quantities, prices or discounts supplied by the client, discounts beyond a permitted
limit, self approval, backdating a document into a closed period, allocating more payment than
exists, and confirming an order that oversells.

### 14.8 Secrets, dependencies, logging

`[REQ]` No secrets in the repository, ever. Injected from the environment, rotated, and
continuous integration fails on a detected secret.

`[REQ]` Dependencies pinned by lockfile and audited in continuous integration.

`[REQ]` Logs are structured and correlated by request id, and never contain credentials,
session identifiers, or personal data beyond what is necessary.

`[FUT]` Shipping security relevant events to a monitoring system.

### 14.9 Security assurance progression

*Added 2026-09-09 at the project lead's request.*

`[DEC]` Security is built and proven in stages, and each stage leaves the application more
testable than it was. It is not a phase before launch and it is not a review the security team
performs on a finished system.

The reason is practical rather than ideological. A penetration test against a system with no
authorization tests finds the same defects the developers would have found, at a much higher
cost and much later. The security team's time is worth spending on what automated tests cannot
reach: chained abuse, business logic, and assumptions nobody wrote down. Getting there requires
the ordinary controls to be already covered by tests we run ourselves.

`[REQ]` A stage is not complete when its control exists. It is complete when a test proves the
control works and a test proves the absence of the control fails. Both directions, because a
test that only asserts the happy path passes equally well when the control is deleted.

**Stage 1, foundation.** Concurrent with the current work.

| Control | Where it is specified |
|---|---|
| Configuration validation, failing fast | 15.2 |
| Dependency audit in continuous integration | 14.8, 15.4 |
| Health endpoint | 15.11 |
| Continuous integration foundation | 15.4, criterion 27 |

**Stage 2, database and security foundation.** Slice 1 and the first migration.

| Control | Where it is specified |
|---|---|
| Tenant isolation | 2.4, 2.5, 2.10, 4.6 |
| Authorization, all four dimensions | 6.1 to 6.4 |
| Database permissions and least privilege roles | 7.1, 15.6 |
| Audit log protection, append only | 7.1 |
| Transaction boundaries | 12.2 |
| Input validation at the boundary | 14.2, 14.3 |

**Stage 3, application.** Slices 1 to 3, as each surface appears.

| Control | Where it is specified |
|---|---|
| Authentication and session security | 5.1 to 5.5 |
| Role based access control and permissions | 6.2, 2.7 |
| Object level authorization, meaning IDOR and BOLA | 6.3, 2.10 |
| Injection protection | 14.2 |
| CSRF, CORS and security headers | 14.4, 14.5 |
| Rate limiting | 14.7 |
| Business logic abuse rules | 14.7 |
| File upload controls, only if uploads are introduced | 14.6 |

`[DEC]` File upload controls are conditional. The product has no upload surface today, and the
correct handling of a control for a feature that does not exist is to not carry the dependency
that implements it. See the adapter decision in section 1.2.

**Stage 4, before production.** Not before there is something worth deploying.

| Control | Where it is specified |
|---|---|
| TLS and HTTPS | 15.6 |
| Secrets management | 15.5 |
| Logging and monitoring | 15.10 |
| Backup and tested restore | 15.9 |
| Production environment isolation | 15.2 |
| Security gates in the delivery pipeline | 15.4 |

**Stage 5, independent security review.** After stage 4, not before.

| Activity | Note |
|---|---|
| Penetration testing, OWASP style | Replaces the `[FUT]` in 14.8, which is now stage 5 rather than undated |
| Authenticated authorization testing | Our matrix test in 13.1 is the floor, not the ceiling |
| Tenant boundary testing | The negative requirements in 2.10 are the brief |
| API abuse testing | Business logic, sequencing, and rate limits |
| Dependency and container scanning | Continuous, not a one off |
| Remediation and retest | A finding is closed by a retest, never by a claim |

`[REQ]` The security team is given the architecture contract, the authorization matrix, the
tenant boundary tests and the threat notes, not just a URL. A reviewer who has to rediscover
the intended boundaries spends their budget on discovery rather than on finding where the
boundaries leak.

`[REQ]` No stage is skipped to reach a deadline. A stage may be descoped explicitly, recorded
in section 18.2 with what was dropped and why, but it is never quietly passed over.

---

## 15. Infrastructure and deployment

*Expanded 2026-09-09 from a shorter section titled Deployment environments. Thirteen principles
were recorded at the project lead's request. The previous clauses were absorbed rather than
duplicated, so each rule still appears exactly once.*

These are principles, not a work item. Section 15.11 states the minimum each slice actually
needs, so that infrastructure does not become a project that outruns the ERP it exists to serve.

### 15.1 The principles, and where each one is stated

| # | Principle | Tag | Detail |
|---|---|---|---|
| 1 | The application must be containerizable | `[REQ]` | 15.3 |
| 2 | Local development is reproducible through Docker | `[DEC]` | 15.3 |
| 3 | CI runs tests, type checks and security checks automatically | `[REQ]` | 15.4 |
| 4 | Production deployments come from a controlled pipeline | `[REQ]` | 15.4 |
| 5 | Production secrets are never stored in the repository | `[REQ]` | 15.5 |
| 6 | Production PostgreSQL has automated backups | `[REQ]` | 15.9 |
| 7 | Production and non-production environments are isolated | `[REQ]` | 15.2 |
| 8 | HTTPS is mandatory in production | `[REQ]` | 15.6 |
| 9 | Application logs and security and audit events are observable | `[REQ]` | 15.10 |
| 10 | The architecture supports cloud deployment | `[DEC]` | 15.6 |
| 11 | Kubernetes is not required initially | `[DEC]` | 15.6 |
| 12 | The ERP core stays a modular monolith until scale proves otherwise | `[DEC]` | 15.7 |
| 13 | Infrastructure is replaceable without changing business logic | `[DEC]` | 15.8 |

### 15.2 Environments

`[DEC]` Four environments: local, continuous integration, staging, production. Staging mirrors
production topology.

`[REQ]` Production and non-production are isolated. Separate databases, separate credentials,
separate secret stores, separate object storage, and no network path from one to the other. A
non-production process must not be able to reach production data even by misconfiguration.

`[REQ]` Non-production never holds a copy of live customer data. Staging runs synthetic or
anonymised data. In a multi-tenant product this is sharper than usual: a staging copy of
production is a copy of every customer's books at once.

`[REQ]` Configuration comes from the environment. A single configuration module reads and
validates it at startup and fails fast on anything missing. No environment branching scattered
through the code.

### 15.3 Containers and local development

`[REQ]` Every deployable process is containerizable, building to an image from a Dockerfile in
the repository, with no dependency on a developer's machine state.

`[DEC]` Local development is reproducible through Docker Compose. One command brings up the
dependencies a developer needs, starting with PostgreSQL.

`[DEC]` Running the application itself in a container locally is optional. Compose owns the
backing services; the developer may run the application natively for a faster edit cycle. The
container image is what CI builds and what production runs, so the image is exercised on every
pipeline run rather than only at release.

`[REQ]` The same image, built once, is what runs in every environment. Environments differ by
configuration, never by build.

### 15.4 Delivery pipeline

`[REQ]` Continuous integration runs on every push and every pull request, and all of it must
pass: type checking, lint, unit tests, integration tests against a real PostgreSQL instance,
dependency audit, and a secret scan.

`[REQ]` Production deployments come only from the pipeline, from a reviewed commit on the main
branch. No deployment from a developer machine, ever. The pipeline is the only credential holder
that can reach production.

`[REQ]` Migrations run as a separate gated step, never automatically at application start, so
that a rolling restart cannot race a schema change.

`[REQ]` Schema changes are backward compatible across a deployment, using expand then contract,
so old and new application versions can run simultaneously during a rollout.

`[REQ]` Every deployment is traceable to a commit, and rollback is a supported, rehearsed
operation rather than an improvisation.

`[FUT]` Progressive delivery, meaning canary or blue and green rollouts, once uptime
expectations justify the added machinery.

### 15.5 Configuration and secrets

`[REQ]` No secret is ever committed. This is stated once, in section 14.8, together with the
requirement that continuous integration fails on a detected secret.

`[REQ]` Production secrets live in a managed secret store, are injected at runtime, are
different in every environment, and are rotatable without a code change.

`[REQ]` A secret that has been exposed is rotated, not merely removed from the working tree. Git
history keeps what was committed.

### 15.6 Production platform, cloud and HTTPS

`[REQ]` HTTPS is mandatory in production. TLS terminates at the edge, HTTP Strict Transport
Security is sent, and plaintext is acceptable only on a private network segment between the edge
and the application.

`[REQ]` The database is not reachable from the public internet. Least privilege database roles,
with the application role holding no `UPDATE` or `DELETE` on the audit table, per section 7.1.

`[DEC]` The architecture supports cloud deployment, which means something specific rather than
aspirational: application processes are stateless, all state lives in PostgreSQL, object storage
or a cache, configuration arrives from the environment, and capacity is added by running more
processes rather than a bigger one.

`[DEC]` Kubernetes is not required initially and will not be adopted for its own sake. A managed
container platform, or a virtual machine running Compose, is sufficient for a single deployable
with one database. The trigger for revisiting is concrete: several independently scaled
processes, or availability requirements a single platform's primitives cannot meet.

`[FUT]` High availability replicas, and stated recovery time and recovery point objectives.

### 15.7 The ERP core is a modular monolith

`[DEC]` One deployable, partitioned internally by business module: identity, sales, purchasing,
inventory, accounting. Modules are boundaries in the code, not network boundaries.

The reason is stated in section 12.2 and is worth repeating here. The ERP core is one
transactional consistency domain. Posting an invoice writes the document, the ledger entries,
the audit record and the number allocation in a single transaction. Splitting that across
services replaces transactions with sagas and eventual consistency, and produces books that
cannot be reconciled. That is the failure this decision exists to prevent.

`[REQ]` A module never reads or writes another module's tables directly. It calls the owning
module's service interface. This is what makes the boundaries real rather than decorative, and
it is enforced by an import rule in continuous integration rather than by good intentions.

`[DEC]` What may be split out first, if anything ever is: work with genuinely different scaling
or availability characteristics, meaning document rendering, bulk import, third party
integrations, and heavy reporting. Those are peripheral. The transactional core is the last
thing to split, not the first.

`[REQ]` Any proposal to split a service states what scale or operational requirement forces it,
and how transactional integrity is preserved across the new boundary. Without both, the answer
is no.

### 15.8 Replaceable infrastructure, and the limit of that idea

`[DEC]` Infrastructure concerns sit behind interfaces owned by the application, so the provider
can change without business logic changing. That applies to the session store, object storage,
mail delivery, the job queue, the rate limiter, and the secret store.

`[DEC]` It explicitly does **not** apply to the database. The system depends deliberately on
PostgreSQL specifics: deferred constraints for the journal balance invariant, row level security
for tenant isolation, `SELECT ... FOR UPDATE` for reservation, exact numeric types for money,
and JSONB for audit diffs. Section 4.1 requires integrity to live in the database, and a
database agnostic abstraction would forfeit exactly the guarantees that clause exists to obtain.

This is worth stating plainly because the two ideas look similar and are not. Replaceable
infrastructure means the hosting and the peripheral services are not load bearing. It does not
mean writing a lowest common denominator data layer. Nobody should build a portability layer
over SQL in this codebase.

### 15.9 Backups and recovery

`[REQ]` Production PostgreSQL has automated backups: encrypted, retained to a stated schedule,
stored separately from the primary, with point in time recovery.

`[REQ]` Restores are tested on a schedule. An untested backup is not a backup.

`[REQ]` A consequence of the shared schema decision in section 2.4 must be planned for rather
than discovered: restoring one tenant's data does not fall out of a database level restore. If a
single customer needs their data recovered without affecting others, that is an application
level export and import path, and it has to be built. Recording it here so the cost of section
2.4 is visible where recovery is discussed.

### 15.10 Observability

`[REQ]` Observability covers three layers: structured logs, metrics and traces for the technical
layer; error tracking; and business level alerts for what matters here, meaning a trial balance
that does not balance, control account drift, a failed posting, and a stock balance that
disagrees with its ledger.

`[REQ]` Logs are structured, correlated by request id, and carry the tenant and company so an
incident can be scoped to a customer. They never contain credentials, session identifiers or
personal data beyond what is necessary, per section 14.8.

`[REQ]` Security and audit events are observable as a first class stream, not by reading
application logs. Failed authentication, lockouts, permission changes, company switches, and any
cross tenant access by platform administration are queryable and alertable.

`[FUT]` Shipping audit and security events to external monitoring or write once storage, already
recorded in sections 7.5 and 14.8.

### 15.11 What each slice actually needs

`[DEC]` This section adds no acceptance criteria to slice 1. The criteria in section 17.3 are
unchanged by it.

| Slice | Infrastructure it pulls in |
|---|---|
| 1, identity | Docker Compose running PostgreSQL for local and CI. The CI workflow already required by criterion 27. Nothing else. |
| 2 to 3, documents and posting | A Dockerfile for the API, built and exercised in CI. |
| Before first customer | Staging environment, deployment pipeline, secret store, TLS, backups with a tested restore, observability and alerting. |

`[DEC]` No Kubernetes, no cloud provisioning, no production pipeline and no deployment tooling
during slice 1. Building deployment machinery before there is something worth deploying is how
infrastructure becomes the project.

---

## 16. Current state: what is temporary, and what must never be faked

### 16.1 Temporary behaviour and its removal trigger

| What | Where | Removal trigger |
|---|---|---|
| Mock identity and role switcher | `app/session.tsx`, `layouts/AppShell.tsx` | slice 1 |
| No route level authorization | `app/router.tsx` | slice 1 |
| Seeded `Account.balance` contradicting the ledger | `mocks/reference.ts`, `mocks/db.ts` | immediate |
| Cash position read from seeded balances | `mocks/db.ts` | immediate |
| Entire fixture layer | `src/mocks/` | per module, as endpoints land |
| Clock pointed at the fixture anchor | `services/index.ts` | when the API supplies dates |
| Synchronous `resolveDocumentRefs` | `services/sales.service.ts` | document links endpoint |
| Stored `links` arrays on documents | `src/domain`, `src/mocks` | first backend document module |
| Money as integer minor units, two decimals | `lib/money.ts` | contracts package adoption |
| Artificial latency in the service layer | `services/client.ts` | real HTTP |
| Document numbers from a JavaScript counter | `mocks/generate.ts` | slice 2 |
| Static cost price used as the costing basis | `mocks/db.ts`, `mocks/generate.ts` | costing implementation, section 8.6 |

### 16.2 Production critical behaviour that must never be faked

The following must be real from the moment they exist at all. A convincing simulation of any
of them is worse than their absence, because it looks finished.

- authentication and session management
- authorization enforcement, at all four dimensions
- audit record generation
- journal entry balancing
- stock movement creation
- document number allocation
- the atomicity of a posting transaction
- period close enforcement

### 16.3 What is already right and should not be rebuilt

- documents with independent lifecycles rather than one record with flags
- payment allocations as a list rather than a single invoice reference
- stock as a movement ledger with no mutable quantity on the product
- account balances derived from journal entries
- per document status unions
- aggregates computed over the whole filtered set rather than the visible page
- a single asynchronous service seam, with no component calling the network directly
- the clock indirection, which prevents an entire class of date bug
- the disabled action buttons that state what they would do, and the one honest placeholder

---

## 17. First vertical slice

### 17.1 Why identity first

The slice builds no business value on purpose. Every other slice depends on being able to
answer "who is doing this", and every operation must write an audit record naming that actor.
Building a document module first would mean either deferring authorization, which contradicts
sections 6 and 7, or building it twice.

### 17.2 Scope

*Amended 2026-09-09. Tenant and company context moved into this slice, because it is the
outermost authorization dimension and cannot be retrofitted around an identity model that was
built without it.*

**In scope.** Monorepo split. PostgreSQL with migrations. Tenants, companies, users,
memberships, roles and permissions. Password authentication. Server side sessions carrying the
active company. The `/me` endpoint. Company switching. Server side authorization middleware with
deny by default. The scoped repository pattern, where scope means tenant, company and actor. The
audit table with append only protection. CSRF protection. The frontend session provider
consuming the API.

**Out of scope.** Business documents, ledgers, inventory, create and edit forms, the company
administration UI itself, invitations, single sign on, multi factor authentication, platform
administration tooling, and field level redaction beyond the mechanism being in place.

Seeding is how companies come into existence during this slice. The administration UI that
creates them is a later slice; the schema, the scoping and the enforcement are this one.

### 17.3 Acceptance criteria

Every criterion below is a test that must pass in continuous integration. "Proven by a test"
is literal.

**Authentication**

1. A user authenticates with email and password verified against an argon2id hash stored in
   PostgreSQL.
2. Invalid credentials return a single generic error, and repeated failures are rate limited
   and locked out, proven by a test.
3. A successful login creates a session row and sets an `HttpOnly`, `Secure`, `SameSite`
   cookie. The response body contains no token or session identifier.
4. Logout invalidates the session server side. A replayed cookie after logout is rejected,
   proven by a test.
5. Idle and absolute session expiry are enforced server side, proven by a test that
   manipulates time rather than waiting.

**Authorization**

6. `GET /me` returns the user, their allowed companies, the active company, their roles in it,
   and their effective permissions in it, all computed server side.
7. Every registered route declares a required permission. A route registered without one
   fails at startup, proven by a test.
8. An unauthenticated request receives 401. An authenticated request without the required
   permission receives 403.
9. An authorization matrix test covers every registered route against every role, with an
   expected allow or deny, generated from the permission registry.
10. The data access layer cannot construct an unscoped query through its public interface,
    proven by a test. Background and system access uses an explicitly named system context.
11. A user cannot assign a role carrying permissions they do not themselves hold, proven by a
    test.

**Tenant and company isolation**

These are the criteria that make this a multi-tenant product rather than a single company one.
Each maps to a negative requirement in section 2.10.

12. The active company is read only from the session. A request that supplies a company
    identifier in a body, query parameter, path segment or header does not change the company it
    is served, proven by a test.
13. Switching company succeeds for a company the user is a member of, and fails for one they are
    not, proven by tests for both cases. A successful switch writes an audit record.
14. Two tenants are seeded with deliberately colliding data. Every read endpoint returns only the
    active tenant's rows, proven by a test that runs each endpoint as a user of each tenant.
15. Requesting a record by identifier that belongs to another tenant returns the same response as
    a record that does not exist, proven by a test. The two responses are compared for equality,
    including status code and body.
16. A company administrator cannot read or modify another company's users, roles or memberships,
    proven by a test.
17. A role granted in one company confers no permission in another, proven by a test using a
    user who is a member of two companies with different roles in each.

**Audit**

18. Login, logout, failed login, and every role or permission change write an audit record in
    the same transaction, with the actor taken from the session.
19. The application database role cannot `UPDATE` or `DELETE` an audit row. A test attempts
    both and expects a database permission error.
20. Audit field changes are stored as structured values, not formatted strings, proven by
    inspecting a stored record.

**Frontend**

21. The session provider consumes `/me`. No file under `app/` or `layouts/` imports from
    `src/mocks`, enforced by a lint rule so it cannot regress.
22. The role switcher is removed, or gated behind a development flag that is absent from a
    production build, verified by grepping the built bundle.
23. Routes are guarded by permission. A user without the permission receives a proper
    forbidden screen rather than a rendered page.
24. A mutating request without the required CSRF header or with a mismatched origin is
    rejected, proven by a test.

**Foundations**

25. Migrations run forward against both an empty and a seeded database in continuous
    integration.
26. A single command brings up the local environment, requiring no network service other than
    PostgreSQL.
27. Continuous integration runs type checking, lint, unit tests, integration tests against a
    real PostgreSQL instance, and a secret scan. All are required to pass.
28. Every tenant-scoped table created in this slice carries `tenant_id` and `company_id`, both
    not null, and the global tables named in 4.6 carry neither. Mutable business tables
    additionally carry `version`; the four exempt shapes in section 4.2, meaning association
    tables, append-only tables, tables whose rows are never updated, and ephemeral operational
    state under last write wins, must not carry it. The exempt set is declared as data rather
    than restated in the test. A test inspects the live schema rather than the migration source,
    so a table added later on the wrong side of either rule fails.
29. The running schema matches the Drizzle definitions. A test reads the live catalogue, meaning
    tables, columns, types, nullability and keys, and compares it against the Drizzle schema, so
    handwritten SQL and typed definitions cannot silently diverge. Section 1.2 makes this the
    price of not generating migrations.
30. Row level security is enabled and forced on every tenant-scoped table, proven by reading the
    catalogue rather than the migration text.
31. A query issued with no tenant context set returns zero rows rather than every row, proven by
    a test. Section 2.4 requires the empty context to deny.
32. The application role holds no `UPDATE` or `DELETE` grant on the audit table, and no `DELETE`
    on tenants, companies or users, proven by reading the catalogue.

### 17.4 Definition of done

All thirty two criteria pass in continuous integration. The web application runs against the
API with no mock identity anywhere in its path. Section 16.1 is updated to strike the rows this
slice removed. Any decision that changed during implementation is recorded in section 18.2.

### 17.5 The two slices after it, for context

**Slice 2, one document written for real.** Sales order create and confirm. The smallest thing
that exercises server side validation, gapless number allocation under concurrency, stock
reservation with two users racing for the last unit, row scoped authorization, an optimistic
locking conflict surfaced properly in the UI, an audit record, and an idempotent retry.

**Slice 3, one posting touching both ledgers.** Post the customer invoice. One atomic
transaction writing the status change, the journal entry and its lines, the audit record and
the document number, with the balance invariant enforced by the database rather than by a
function that throws.

---

## 18. Open questions and amendment log

### 18.1 Open questions

These block specific decisions. Each has a stated default so that work is not blocked while
they are open.

**Closed**

| # | Question | Ruling | Date |
|---|---|---|---|
| 1 | Will the system serve more than one legal entity? | Yes, and more than one independent customer. Multi-tenancy is a core requirement. See section 2. | 2026-09-09 |
| 3 | Server framework and query layer. | React, Vite, NestJS, PostgreSQL, Drizzle. Redis where it earns its place, not in slice 1. See section 1.2. | 2026-09-09 |
| 5 | Tenant isolation strategy. | Shared schema with `tenant_id` and `company_id`, mandatory application scoping, and row level security as a second enforcement layer. Neither layer stands alone. See section 2.4. | 2026-09-09 |
| 7 | Audit hardening mechanism. | A separate restricted application role whose grants do not permit `UPDATE` or `DELETE` on the audit table. Two roles from the first migration. See section 7.1. | 2026-09-09 |

**Open**

| # | Question | Default assumed | What changes with the answer |
|---|---|---|---|
| 2 | Is single sign on a requirement, now or foreseeably? | No, but the seam exists. `external_subject_id` on the user table. | Now larger than before. In a multi-tenant product, single sign on is usually per tenant, so a customer brings their own identity provider. That makes it a tenant configuration domain rather than a global switch. |
| 4 | Which jurisdictions issue invoices, and do any require gapless numbering? | Assume at least one does, per section 10.4. | Determines the default sequence strategy. Now per tenant configuration rather than a single global choice. |
| 6 | Money precision and transport. | `NUMERIC(19,4)` for amounts, `NUMERIC(19,6)` for unit prices, decimal strings over the wire. See section 4.3. | Blocks the contracts package and the frontend money migration, not the identity schema. |
| 8 | Does a tenant ever need more than one company in the first release? | No. Schema carries both identifiers; the UI exposes one company per tenant. | If yes, company switching and per company configuration surface earlier than planned. |

### 18.2 Amendment log

| Date | Section | Change | Reason |
|---|---|---|---|
| 2026-09-09 | all | Document created | Establishing the architectural contract before further implementation |
| 2026-09-09 | new section 2 | Multi-tenancy and company configuration added. All sections from the old 2 onward renumbered by one. | Product goal confirmed: one product serving many independent companies |
| 2026-09-09 | 1.2 | Stack ratified as React, Vite, NestJS, PostgreSQL, Drizzle. Redis deferred. | Open question 3 closed by the project lead |
| 2026-09-09 | 1.4 | Rewritten. The claim that the system is built for one business was withdrawn. Replaced with configuration driven within a fixed schema, and the distinction from metadata driven platforms sharpened. | Contradicted by the confirmed product goal |
| 2026-09-09 | 4.6 | Upgraded from `[DEC]` to `[REQ]`. Now requires `tenant_id` alongside `company_id`, non nullable, leading index columns. | Tenant isolation is no longer optional |
| 2026-09-09 | 6.1 | Authorization went from three dimensions to four. Tenant and company scope added as the outermost, evaluated first, not grantable by any role. | Multi-tenancy makes company scope an authorization boundary rather than a data filter |
| 2026-09-09 | 17.2, 17.3 | Tenant and company context moved into slice 1. Six isolation acceptance criteria added, numbered 12 to 17, and the remainder renumbered. | Company context cannot be retrofitted around an identity model built without it |
| 2026-09-09 | 15 | Retitled from Deployment environments to Infrastructure and deployment. Thirteen principles recorded, existing clauses absorbed rather than duplicated. Section 15.11 bounds what each slice pulls in. | Infrastructure principles requested by the project lead, without expanding slice 1 |
| 2026-09-09 | 14.9 | Security assurance progression added: five stages, each mapping controls to the sections that specify them. The undated penetration test in 14.8 became stage 5. | Security must be progressively testable rather than deferred to a review at the end |
| 2026-09-09 | 1.2 | HTTP adapter ratified as Fastify rather than Express, and a HOST setting added defaulting to loopback. | The Express platform package carries unpatched multer advisories that npm overrides did not resolve; the dependency audit in 14.8 and 15.4 must pass without suppression |
| 2026-09-09 | 4.2, 8.6, 16.2, 17.4 | Corrected six references left stale by the section 2 renumbering. 4.2 also gained `tenant_id`, which it had omitted while 4.6 required it. | Bookkeeping errors in the renumbering, and a genuine contradiction between 4.2 and 4.6 that the first migration would otherwise have followed |
| 2026-09-09 | 2.4 | Tenant isolation ratified as shared schema with row level security as a mandatory second layer. The approval callout was removed and two clauses added: neither layer may stand alone, and the application role must not bypass row level security. | Open question 5 closed by the project lead |
| 2026-09-09 | 7.1 | Audit hardening ratified as revoked grants on a separate restricted application role, rejecting the trigger alternative. Two database roles required from the first migration, in every environment. | Open question 7 closed by the project lead |
| 2026-09-09 | 4.6 | Scope requirement narrowed from every business table to every tenant-scoped table, with `tenants`, `users` and `sessions` named as a closed global exception and still subject to authorization. | The blanket wording contradicted the one account per person ruling in 2.6 and could not be satisfied by the first migration |
| 2026-09-09 | 7.3 | `tenant_id` and `company_id` made nullable on the audit table alone, constrained to the authentication actions. | A failed login precedes any company, and criterion 18 requires it audited |
| 2026-09-09 | 2.4 | Row level security context ruled to be transaction local settings via `SET LOCAL`, requiring every scoped query to run in a transaction, policies to deny on empty context, and a test proving no context returns no rows. | The mechanism was unspecified and the default failure mode is the dangerous one |
| 2026-09-09 | 2.7 | Granted capabilities stored as permission strings with no `permissions` table, validated on write and asserted against the catalogue at startup. | A seeded table would duplicate what the code already defines |
| 2026-09-10 | 1.2 | Migration tooling ruled final: handwritten versioned SQL applied by a runner on `pg`, `drizzle-orm` kept for typed schema and queries, `drizzle-kit` dropped. Forward only, checksummed, run as the owning role. | `drizzle-kit` carries unpatchable moderate advisories, and grants, policies and composite tenant keys cannot be expressed in a schema DSL anyway |
| 2026-09-10 | 17.3 | Criterion 28 narrowed to tenant-scoped tables and four criteria added, numbered 29 to 32: live schema matches the Drizzle definitions, row level security enabled and forced, empty context returns no rows, and audit grants verified from the catalogue. | Drift protection is the price of handwritten migrations, and the isolation controls need catalogue level proof rather than trust in the migration text |
| 2026-09-10 | 7.1 | Added the requirement that neither database role is a superuser, with the owning role taking DDL rights from owning the database and schema instead. | A superuser bypasses row level security even with FORCE, which made the first isolation tests incapable of failing |
| 2026-09-10 | 4.2, 17.3 | `version` narrowed from every business table to mutable tables only, with association tables and append-only tables exempted by reason rather than by name. Criterion 28 updated to match, and an unused `version` on an exempt table made a defect in its own right. | A version column on a table that is never updated has no reader, and a concurrency control nobody checks is worse than an absent one |
| 2026-09-10 | 4.2, 17.3 | Added a fourth `version` exemption for ephemeral operational state under an explicit last-write-wins model, gated on four conditions that all must hold. `sessions` is the only example. Criterion 28 updated to name all four shapes. | `sessions.last_seen_at` is written by ordinary concurrent requests from one principal, where optimistic locking would produce conflicts that describe nothing real |
| 2026-09-10 | 4.6 | `auth_throttle` added to the closed list of global tables, with the reasoning stated and the infrastructure-exemption argument explicitly refused. | Authentication precedes tenant resolution, and per-address throttling has no user row or tenant to attribute an attempt to |
| 2026-09-10 | 2.9, 5.3 | Authentication-time policy ruled deployment level: session lifetime, password rules and login throttling. Section 2.9 narrowed to point at 5.3. Per-company override recorded as future. | 2.9 made these per-company, but authentication happens before any company is known, so the two clauses could not both hold |
| 2026-09-10 | 7.3, 4.6 | Platform level audit rows ruled readable only in an empty tenant context, replacing a select policy that admitted none. The stale claim in 4.6 that such rows could be written but not read was corrected. | The policy governed the `RETURNING` clause of the insert as well, so authentication audit rows could not be written at all and criterion 18 was unimplementable |
| 2026-09-10 | 4.6 | Corrected the claim that `auth_throttle` carries no personal data beyond an address. It carries the attempted email, which is personal data whether or not it matches an account. Retention obligation stated and the missing reaper recorded as future. | Review of 6b612f2 against the table the migration actually creates |
| 2026-09-10 | 2.4, 2.5 | A third transaction local setting added for the acting person, with one policy admitting a person's own membership rows when no tenant context is set. Section 2.5 gained the two session states, the two-stage membership check, and the rule that the session stores the company and never the tenant. | Company discovery is cross-tenant by construction under 2.6, so no tenant scoped context could answer it, and the switch sequence was specified as a sentence rather than as an order of operations |
