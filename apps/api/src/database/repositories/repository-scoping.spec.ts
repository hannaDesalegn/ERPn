/**
 * A source level guardrail on the scope predicates in the newest repositories.
 *
 * WHY THIS IS NOT A BEHAVIOURAL TEST, and the finding that led to it. Removing the tenant and
 * company predicates from `DrizzleJournalRepository.findById` leaves every integration test in
 * `accounting/journal.int.spec.ts` green, because row level security denies the same rows a
 * moment later. That is the second layer working, and it is exactly why section 2.4 requires both
 * and permits neither to stand alone: the day a policy is dropped, or a table is added without
 * one, the repository predicate is the only thing left. A test that cannot tell the two apart
 * cannot protect the first layer, so this one reads the source instead.
 *
 * It is a blunt instrument, deliberately, in the shape `auth/secret-handling.spec.ts` already
 * established for a rule that behaviour cannot demonstrate. If a query here ever legitimately
 * needs to reach across a company, the change has to come to this file and be argued for.
 *
 * IT COVERS THE FILES IT NAMES, and the list is pinned below so that adding a repository without
 * adding it here fails rather than going unchecked. The older repositories are not covered yet;
 * bringing them in is a change worth making deliberately rather than as a side effect of this.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repositories this guard covers. */
const GUARDED = ['accounting.repository.ts', 'billing.repository.ts'] as const;

/** Comments are exempt: the rule is about what the query does, not about what explains it. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

interface Method {
  file: string;
  name: string;
  body: string;
}

/**
 * Every method in the file, with its body.
 *
 * Split on the method signature rather than parsed, which is enough: each chunk runs to the start
 * of the next method, so a predicate belonging to one cannot be counted for another.
 */
const methodsOf = (file: string): Method[] => {
  const source = withoutComments(readFileSync(join(HERE, file), 'utf8'));
  const signature = /^\s{2}(?:private\s+)?async\s+(\w+)\s*\(/gm;
  const found: Method[] = [];
  let match: RegExpExecArray | null;
  const starts: { name: string; index: number }[] = [];

  while ((match = signature.exec(source)) !== null) {
    starts.push({ name: match[1]!, index: match.index });
  }

  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]!;
    const end = starts[i + 1]?.index ?? source.length;
    found.push({ file, name: start.name, body: source.slice(start.index, end) });
  }

  return found;
};

const methods: Method[] = GUARDED.flatMap(methodsOf);

/** A method that reads or writes a table, as opposed to one that maps a row. */
const touchesTheDatabase = (method: Method) =>
  /\.from\(|\.insert\(|\.update\(|\.delete\(/.test(method.body);

/**
 * A method whose scope has to be a predicate: it selects rows, narrows an update, or narrows a
 * delete. A delete belongs here rather than with the writes below: what makes it safe is the
 * predicate that stops it reaching another company's row, not a column it stamps.
 */
const reads = (method: Method) => /\.from\(|\.update\(|\.delete\(/.test(method.body);

/** A method whose scope has to be stamped onto the row it writes. */
const writes = (method: Method) => /\.insert\(/.test(method.body);

describe('Scope predicates in the guarded repositories', () => {
  it('covers the files it claims to, so a new repository is not silently unguarded', () => {
    expect([...GUARDED]).toEqual(['accounting.repository.ts', 'billing.repository.ts']);
  });

  it('found the methods it is meant to be guarding', () => {
    // Without this, a rename or a refactor turns the whole suite into a vacuous pass over an
    // empty list, and it would still be green. The list is pinned so that adding a method is a
    // visible decision rather than a silent exemption.
    expect(methods.map((method) => method.name)).toEqual([
      // Accounts
      'findById',
      'findByCode',
      'listForCompany',
      'create',
      'archive',
      // Posting accounts
      'findForPurpose',
      'listForCompany',
      'create',
      'pointTo',
      // The journal
      'record',
      'findById',
      'listForSourceDocument',
      'linesOf',
      // Customer invoices
      'findById',
      'listForCompany',
      'create',
      'updateDraft',
      'setTotals',
      'applyTransition',
      // Customer invoice lines
      'listForInvoice',
      'listForSourceOrder',
      'create',
      'remove',
    ]);
  });

  it('reaches the database in every one of them, so the filter below is not vacuous', () => {
    expect(methods.filter(touchesTheDatabase)).toHaveLength(methods.length);
  });

  it.each(methods.map((method) => [`${method.file} ${method.name}`, method] as const))(
    '%s takes its scope from the scope rather than from an argument',
    (_name, method) => {
      // The scope is read once, from the scope object, and throws when there is none. A method
      // that skipped this would have no tenant or company to filter by in the first place.
      expect(method.body).toMatch(/requireCompanyScope\(this\.scope/);
    },
  );

  it.each(methods.filter(reads).map((method) => [`${method.file} ${method.name}`, method] as const))(
    '%s filters on both scope columns in the query itself',
    (_name, method) => {
      // Section 6.3: the predicate goes in the query, never applied to the rows afterwards. Row
      // level security denies the same rows, and this is the layer that must not depend on it.
      //
      // The pattern is the comparison, not the word. Reading the scope into a local and then
      // never using it is precisely the mutation that leaves every behavioural test green,
      // because the policy catches what the missing predicate let through.
      expect(method.body).toMatch(/eq\(\w+\.tenantId, tenantId\)/);
      expect(method.body).toMatch(/eq\(\w+\.companyId, companyId\)/);
    },
  );

  it.each(methods.filter(writes).map((method) => [`${method.file} ${method.name}`, method] as const))(
    '%s stamps both scope columns onto the row it writes',
    (_name, method) => {
      // The other half of the rule: a write takes its tenant and company from the scope rather
      // than from the input, and the input types have no field with which to supply them.
      expect(method.body).toMatch(/\.values\(\{[\s\S]*?\n\s+tenantId,\n\s+companyId,/);
    },
  );

  it.each([...GUARDED])('never takes a tenant or a company as an argument in %s', (file) => {
    // The vulnerability this layer exists to prevent: a caller reading an identifier out of a
    // request body and handing it in as authority.
    const source = withoutComments(readFileSync(join(HERE, file), 'utf8'));

    expect(source).not.toMatch(/\b(tenantId|companyId)\s*:\s*string/);
  });
});
