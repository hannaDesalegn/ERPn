/**
 * A source level guardrail on the files that touch a credential.
 *
 * The integration suite proves that no secret reaches an output stream during a login, a
 * validation and a logout. That covers the paths those tests walk. This one covers the paths
 * they do not, because the way a password hash reaches a log is almost never the happy path: it
 * is a debug line added during an incident, on an error branch nobody exercises.
 *
 * So the rule is enforced against the text of the files rather than their behaviour. It is a
 * blunt instrument on purpose. If logging genuinely belongs in one of these files one day, the
 * change has to come here and be argued for, which is the point.
 *
 * It covers the HTTP files as well as the authentication ones. The cookie helper and the session
 * guard both hold the raw token in a local variable, which makes them exactly as good a place
 * for an accidental debug line as the service that issued it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTH_DIR = dirname(fileURLToPath(import.meta.url));
const HTTP_DIR = join(AUTH_DIR, '..', 'http');

/**
 * Files in those directories that hold no credential and may log.
 *
 * A named list rather than a pattern, and short by design. Every entry is a claim that the file
 * never holds a password, a hash or a session token, and the assertion below pins the list so
 * that adding to it is a visible decision in review rather than a way around the rule.
 */
const MAY_LOG = new Set([
  // Walks controller metadata at startup. It never sees a request, and reporting which routes
  // failed to declare an access rule is the whole point of it.
  'route-declarations.ts',
]);

const sourceFiles = [AUTH_DIR, HTTP_DIR].flatMap((directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && !name.includes('.spec.') && !MAY_LOG.has(name))
    .map((name) => [name, readFileSync(join(directory, name), 'utf8')] as const),
);

/** Comments are exempt. The prohibition is on emitting, not on explaining. */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Secret handling in the authentication files', () => {
  it('found the files it is meant to be guarding', () => {
    // Without this, a rename or a move turns the whole suite into a vacuous pass over an empty
    // list, and it would still be green.
    expect([...MAY_LOG]).toEqual(['route-declarations.ts']);
    expect(sourceFiles.map(([name]) => name).sort()).toEqual([
      'access.guard.ts',
      'auth.controller.ts',
      'auth.module.ts',
      'authentication.service.ts',
      'csrf.guard.ts',
      'csrf.ts',
      'password-hasher.ts',
      'plugins.ts',
      'principal.ts',
      'session-cookie.ts',
      'session-policy.ts',
      'session-token.ts',
    ].sort());
  });

  it.each(sourceFiles)('%s calls no logger and no console', (_name, source) => {
    const code = withoutComments(source);

    expect(code).not.toMatch(/\bconsole\s*\./);
    expect(code).not.toMatch(/\bnew Logger\b/);
    expect(code).not.toMatch(/\bLogger\s*\./);
    expect(code).not.toMatch(/\bprocess\.std(out|err)\b/);
  });

  it.each(sourceFiles)('%s embeds no credential shaped literal', (_name, source) => {
    const code = withoutComments(source);

    // A hard coded argon2 hash is the specific mistake this catches. The decoy hash used to
    // equalise timing for a nonexistent account was written as a literal once, which made it
    // both a fake credential in source and a value argon2 rejects while parsing, so it returned
    // immediately and defeated the very timing defence it was there to provide.
    //
    // Matched inside quotes only. The PHC parser in password-hasher.ts holds the same prefix in
    // a regular expression, which is a reader of hashes rather than one of them, and a rule that
    // could not tell the two apart would be worked around rather than obeyed.
    const embeddedArgon2 = /['"`][^'"`]*\$argon2[a-z0-9]*\$v=\d+\$m=\d+/;
    const embeddedBcrypt = /['"`][^'"`]*\$2[aby]\$\d\d\$/;

    // The rule proves it can still fire. A pattern that matches nothing passes every file and
    // reads exactly like one that works.
    expect(`const decoy = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$ZGlnZXN0';`).toMatch(
      embeddedArgon2,
    );
    expect(code).not.toMatch(embeddedArgon2);
    expect(code).not.toMatch(embeddedBcrypt);
  });
});
