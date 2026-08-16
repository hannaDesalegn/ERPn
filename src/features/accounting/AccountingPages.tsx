/**
 * Accounting screens: chart of accounts, general ledger, journal entries,
 * trial balance.
 *
 * IMPORTANT: every figure on these screens is derived from journal lines.
 * `Account.balance` exists in the fixtures but is NOT read here, because it is a
 * stored duplicate of something the ledger already determines. Reading it would
 * create two answers to the same question, and the trial balance exists
 * precisely to catch that class of disagreement.
 */

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, queryKeys } from '@/services';
import type { Account, AccountType, JournalEntry } from '@/domain';
import { Badge, Card, CardHeader, ErrorState, Field, Icon, PageHeader, SearchInput, Select, Skeleton, Toolbar } from '@/components/ui';
import { DataTable, Pagination, type Column } from '@/components/ui/DataTable';
import { MoneyText } from '@/components/domain/MoneyText';
import { StatusBadge } from '@/components/domain/StatusBadge';
import { DocumentLink } from '@/components/domain/documents';
import { DetailGrid, DetailSkeleton, DetailTitle, HistoryPanel } from '@/components/domain/detail';
import { useListParams } from '@/hooks/useListParams';
import { cn, formatDate, formatNumber, humanize } from '@/lib/format';
import { formatMoney } from '@/lib/money';

const TYPE_TONES: Record<AccountType, 'info' | 'warning' | 'accent' | 'success' | 'danger'> = {
  asset: 'info',
  liability: 'warning',
  equity: 'accent',
  revenue: 'success',
  expense: 'danger',
};

// ===========================================================================
// Chart of accounts
// ===========================================================================

export function ChartOfAccountsPage() {
  const navigate = useNavigate();
  const accounts = useQuery({ queryKey: queryKeys.chartOfAccounts, queryFn: api.finance.chartOfAccounts });
  const trial = useQuery({ queryKey: queryKeys.trialBalance, queryFn: api.finance.trialBalance });

  // Balances come from the ledger, keyed by account. Accounts with no postings
  // simply have no entry, which is different from having a balance of zero.
  const ledgerBalance = new Map<string, number>();
  for (const row of trial.data?.rows ?? []) {
    const account = accounts.data?.find((a) => a.id === row.accountId);
    if (!account) continue;
    const net =
      account.normalBalance === 'debit'
        ? row.debit.amount - row.credit.amount
        : row.credit.amount - row.debit.amount;
    ledgerBalance.set(row.accountId, net);
  }

  const columns: Column<Account>[] = [
    {
      key: 'code',
      header: 'Code',
      width: '90px',
      render: (a) => <span className={cn('tabular', a.postable ? 'text-secondary' : 'font-semibold text-primary')}>{a.code}</span>,
    },
    {
      key: 'name',
      header: 'Account',
      render: (a) => (
        <span
          className={cn(
            a.postable ? 'text-primary' : 'font-semibold text-primary',
            // Child accounts are indented under their heading so the hierarchy
            // is legible without a tree widget.
            a.parentId && 'pl-4',
          )}
        >
          {a.name}
        </span>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: '120px',
      render: (a) => <Badge tone={TYPE_TONES[a.type]}>{humanize(a.type)}</Badge>,
    },
    {
      key: 'normal',
      header: 'Normal',
      width: '90px',
      hideBelow: 'lg',
      render: (a) => <span className="text-xs text-muted">{humanize(a.normalBalance)}</span>,
    },
    {
      key: 'postable',
      header: '',
      width: '100px',
      hideBelow: 'xl',
      render: (a) => (!a.postable ? <Badge tone="neutral">Heading</Badge> : null),
    },
    {
      key: 'balance',
      header: 'Ledger balance',
      align: 'right',
      numeric: true,
      width: '140px',
      render: (a) => {
        const value = ledgerBalance.get(a.id);
        if (value === undefined) return <span className="text-muted">No postings</span>;
        return <MoneyText value={{ amount: value, currency: 'USD' }} strong />;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        subtitle="Balances derived from posted journal entries"
      />

      <Card padded={false}>
        <DataTable
          columns={columns}
          rows={accounts.data ?? []}
          rowKey={(a) => a.id}
          isLoading={accounts.isLoading || trial.isLoading}
          onRowClick={(a) => (a.postable ? navigate(`/accounting/accounts/${a.id}`) : undefined)}
          rowTone={(a) => (a.postable ? 'default' : 'muted')}
          emptyTitle="No accounts"
        />
      </Card>
    </>
  );
}

// ===========================================================================
// General ledger for one account
// ===========================================================================

export function GeneralLedgerPage() {
  const { id = '' } = useParams();
  const ledger = useQuery({
    queryKey: queryKeys.generalLedger(id),
    queryFn: () => api.finance.generalLedger(id),
  });

  if (ledger.isError) return <ErrorState message={(ledger.error as Error).message} />;
  if (ledger.isLoading || !ledger.data) return <DetailSkeleton />;

  const { account, rows } = ledger.data;

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/accounting/accounts"
            backLabel="Back to chart of accounts"
            docNumber={`${account.code} ${account.name}`}
          />
        }
        subtitle={`${humanize(account.type)} · increases on the ${account.normalBalance} side`}
        meta={<Badge tone={TYPE_TONES[account.type]}>{humanize(account.type)}</Badge>}
      />

      <Card padded={false}>
        <CardHeader title="General ledger" subtitle={`${rows.length} postings, most recent first`} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Entry</th>
                <th className="px-3 py-2 text-left">Memo</th>
                <th className="hidden px-3 py-2 text-left lg:table-cell">Party</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
                <th className="px-3 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-line">
                  <td className="px-3 py-2 whitespace-nowrap text-secondary tabular">{formatDate(row.date)}</td>
                  <td className="px-3 py-2">
                    <Link
                      to={`/accounting/journal/${row.journalEntryId}`}
                      className="font-medium text-accent-text hover:underline"
                    >
                      {row.journalEntryNumber}
                    </Link>
                  </td>
                  <td className="max-w-64 truncate px-3 py-2 text-primary">{row.memo}</td>
                  <td className="hidden px-3 py-2 text-secondary lg:table-cell">{row.partyName}</td>
                  <td className="px-3 py-2 text-right">
                    {row.debit.amount > 0 && <MoneyText value={row.debit} />}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.credit.amount > 0 && <MoneyText value={row.credit} />}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <MoneyText value={row.runningBalance} strong />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted">No postings to this account.</p>
        )}
      </Card>
    </>
  );
}

// ===========================================================================
// Journal entries
// ===========================================================================

export function JournalEntriesPage() {
  const navigate = useNavigate();
  const list = useListParams({ defaultSortBy: 'entryDate', filterKeys: ['origin'] });

  const query = useQuery({
    queryKey: queryKeys.journalEntries(list.params),
    queryFn: () => api.finance.listJournalEntries(list.params),
  });

  const columns: Column<JournalEntry>[] = [
    {
      key: 'docNumber',
      header: 'Entry',
      sortable: true,
      width: '130px',
      render: (j) => <span className="font-medium text-accent-text">{j.docNumber}</span>,
    },
    {
      key: 'entryDate',
      header: 'Date',
      sortable: true,
      width: '110px',
      numeric: true,
      render: (j) => <span className="text-secondary">{formatDate(j.entryDate)}</span>,
    },
    { key: 'memo', header: 'Memo', render: (j) => <span className="truncate text-primary">{j.memo}</span> },
    {
      /**
       * Manual entries have no source document. Auditors look at those first,
       * because a figure nobody can trace to a business event is where errors
       * and fraud hide. Flagging them in the list is the point of this column.
       */
      key: 'origin',
      header: 'Origin',
      width: '120px',
      render: (j) =>
        j.origin === 'manual' ? <Badge tone="warning">Manual</Badge> : <Badge tone="neutral">System</Badge>,
    },
    {
      key: 'source',
      header: 'Source document',
      width: '170px',
      hideBelow: 'lg',
      render: (j) => (j.sourceDocument ? <DocumentLink refDoc={j.sourceDocument} showIcon /> : null),
    },
    {
      key: 'amount',
      header: 'Amount',
      sortable: true,
      align: 'right',
      numeric: true,
      width: '120px',
      render: (j) => <MoneyText value={j.totalDebit} strong />,
    },
  ];

  return (
    <>
      <PageHeader title="Journal entries" subtitle="Every posting to the ledger" />

      <Card padded={false}>
        <Toolbar>
          <SearchInput
            className="w-full sm:w-64"
            placeholder="Search entry, memo, document"
            value={list.search}
            onChange={(e) => list.setSearch(e.target.value)}
            aria-label="Search journal entries"
          />
          <Select
            value={list.filters['origin']?.[0] ?? ''}
            onChange={(e) => list.setFilter('origin', e.target.value ? [e.target.value] : [])}
            aria-label="Filter by origin"
          >
            <option value="">All entries</option>
            <option value="system">System generated</option>
            <option value="manual">Manual only</option>
          </Select>
          {list.isFiltered && (
            <button type="button" onClick={list.clearAll} className="text-xs text-accent-text hover:underline">
              Clear
            </button>
          )}
          {query.data && (
            <span className="ml-auto text-xs text-muted tabular">
              {formatNumber(query.data.total)} entries
            </span>
          )}
        </Toolbar>

        <DataTable
          columns={columns}
          rows={query.data?.rows ?? []}
          rowKey={(j) => j.id}
          isLoading={query.isLoading}
          onRowClick={(j) => navigate(`/accounting/journal/${j.id}`)}
          sortBy={list.sortBy}
          sortDir={list.sortDir}
          onSortChange={list.setSort}
          emptyTitle="No journal entries match"
        />

        {query.data && (
          <Pagination
            page={query.data.page}
            pageSize={query.data.pageSize}
            total={query.data.total}
            onPageChange={list.setPage}
          />
        )}
      </Card>
    </>
  );
}

// ===========================================================================
// One journal entry
// ===========================================================================

export function JournalEntryDetailPage() {
  const { id = '' } = useParams();
  const entry = useQuery({ queryKey: queryKeys.journalEntry(id), queryFn: () => api.finance.getJournalEntry(id) });

  if (entry.isError) return <ErrorState message={(entry.error as Error).message} />;
  if (entry.isLoading || !entry.data) return <DetailSkeleton />;

  const j = entry.data;
  const balanced = j.totalDebit.amount === j.totalCredit.amount;

  return (
    <>
      <PageHeader
        title={
          <DetailTitle
            backTo="/accounting/journal"
            backLabel="Back to journal entries"
            docNumber={j.docNumber}
            status={j.status}
          />
        }
        subtitle={`${j.memo} · ${formatDate(j.entryDate)}`}
        meta={
          j.origin === 'manual' ? (
            <Badge tone="warning">Manual entry, no source document</Badge>
          ) : undefined
        }
      />

      <DetailGrid
        main={
          <Card padded={false}>
            <CardHeader title="Postings" subtitle={`${j.lines.length} lines`} />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                    <th className="px-3 py-2 text-left">Account</th>
                    <th className="hidden px-3 py-2 text-left lg:table-cell">Party</th>
                    <th className="hidden px-3 py-2 text-left xl:table-cell">Description</th>
                    <th className="px-3 py-2 text-right">Debit</th>
                    <th className="px-3 py-2 text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {j.lines.map((line) => (
                    <tr key={line.id} className="border-b border-line">
                      <td className="px-3 py-2">
                        <Link
                          to={`/accounting/accounts/${line.accountId}`}
                          className="hover:text-accent-text hover:underline"
                        >
                          <span className="text-muted tabular">{line.accountCode}</span>{' '}
                          <span className="text-primary">{line.accountName}</span>
                        </Link>
                      </td>
                      <td className="hidden px-3 py-2 text-secondary lg:table-cell">{line.partyName}</td>
                      <td className="hidden px-3 py-2 text-secondary xl:table-cell">{line.description}</td>
                      <td className="px-3 py-2 text-right">
                        {line.debit.amount > 0 && <MoneyText value={line.debit} strong />}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {line.credit.amount > 0 && <MoneyText value={line.credit} strong />}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-line-strong bg-sunken font-semibold">
                    <td className="px-3 py-2" colSpan={1}>
                      Totals
                    </td>
                    <td className="hidden lg:table-cell" />
                    <td className="hidden xl:table-cell" />
                    <td className="px-3 py-2 text-right">
                      <MoneyText value={j.totalDebit} strong />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <MoneyText value={j.totalCredit} strong />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* The invariant, stated on the document. Debits must equal credits. */}
            <div
              className={cn(
                'flex items-center gap-2 border-t border-line px-4 py-2.5 text-xs',
                balanced ? 'text-success-text' : 'text-danger-text',
              )}
            >
              <Icon name={balanced ? 'check' : 'alert'} className="size-3.5" />
              {balanced
                ? 'Debits equal credits. This entry balances.'
                : 'This entry does not balance and must be corrected.'}
            </div>
          </Card>
        }
        aside={
          <>
            <Card padded={false}>
              <CardHeader title="Entry" />
              <dl className="grid grid-cols-2 gap-4 p-4">
                <Field label="Date">{formatDate(j.entryDate)}</Field>
                <Field label="Origin">{humanize(j.origin)}</Field>
                <Field label="Posted by">{j.postedBy?.name}</Field>
                <Field label="Status">
                  <StatusBadge status={j.status} />
                </Field>
              </dl>
            </Card>

            <Card padded={false}>
              <CardHeader title="Source document" />
              {j.sourceDocument ? (
                <div className="px-4 py-3">
                  <DocumentLink refDoc={j.sourceDocument} showIcon className="text-sm" />
                  <p className="mt-1 text-xs text-muted">
                    This entry was generated automatically when that document was posted.
                  </p>
                </div>
              ) : (
                <p className="px-4 py-4 text-xs text-muted">
                  Entered manually with no originating document. Manual entries are the first thing an
                  auditor reviews.
                </p>
              )}
            </Card>

            <HistoryPanel targetId={j.id} />
          </>
        }
      />
    </>
  );
}

// ===========================================================================
// Trial balance
// ===========================================================================

export function TrialBalancePage() {
  const trial = useQuery({ queryKey: queryKeys.trialBalance, queryFn: api.finance.trialBalance });

  if (trial.isLoading || !trial.data) {
    return (
      <>
        <PageHeader title="Trial balance" />
        <Skeleton className="h-96 rounded-lg" />
      </>
    );
  }

  const { rows, totalDebit, totalCredit, balanced } = trial.data;

  return (
    <>
      <PageHeader
        title="Trial balance"
        subtitle="Total debits and credits per account, from posted entries"
      />

      {/*
        The headline is not a number, it is a yes or no. If the two totals do not
        agree the books are broken and nothing downstream can be trusted, so that
        verdict belongs at the top rather than at the bottom of a long table.
      */}
      <Card
        className={cn('mb-4', balanced ? 'border-success/40 bg-success-soft/25' : 'border-danger/40 bg-danger-soft/30')}
      >
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={cn(
              'grid size-8 place-items-center rounded-full',
              balanced ? 'bg-success-soft text-success-text' : 'bg-danger-soft text-danger-text',
            )}
          >
            <Icon name={balanced ? 'check' : 'alert'} className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className={cn('text-sm font-semibold', balanced ? 'text-success-text' : 'text-danger-text')}>
              {balanced ? 'In balance' : 'Out of balance'}
            </p>
            <p className="text-xs text-secondary">
              {balanced
                ? 'Total debits equal total credits across every posted entry.'
                : 'Debits and credits disagree. Investigate before producing any financial statement.'}
            </p>
          </div>
          <dl className="flex gap-6 text-sm">
            <div>
              <dt className="text-2xs tracking-wide text-muted uppercase">Debits</dt>
              <dd className="font-semibold text-primary tabular">
                {formatMoney({ amount: totalDebit, currency: 'USD' })}
              </dd>
            </div>
            <div>
              <dt className="text-2xs tracking-wide text-muted uppercase">Credits</dt>
              <dd className="font-semibold text-primary tabular">
                {formatMoney({ amount: totalCredit, currency: 'USD' })}
              </dd>
            </div>
          </dl>
        </div>
      </Card>

      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-sunken text-2xs tracking-wide text-secondary uppercase">
                <th className="px-3 py-2 text-left">Code</th>
                <th className="px-3 py-2 text-left">Account</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.accountId} className="border-b border-line">
                  <td className="px-3 py-2 text-secondary tabular">{row.accountCode}</td>
                  <td className="px-3 py-2">
                    <Link
                      to={`/accounting/accounts/${row.accountId}`}
                      className="text-primary hover:text-accent-text hover:underline"
                    >
                      {row.accountName}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={TYPE_TONES[row.accountType]}>{humanize(row.accountType)}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.debit.amount > 0 && <MoneyText value={row.debit} />}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {row.credit.amount > 0 && <MoneyText value={row.credit} />}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-line-strong bg-sunken font-semibold">
                <td className="px-3 py-2" colSpan={3}>
                  Totals
                </td>
                <td className="px-3 py-2 text-right tabular">
                  {formatMoney({ amount: totalDebit, currency: 'USD' })}
                </td>
                <td className="px-3 py-2 text-right tabular">
                  {formatMoney({ amount: totalCredit, currency: 'USD' })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
    </>
  );
}
