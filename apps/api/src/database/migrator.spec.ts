import {
  MigrationError,
  checksumOf,
  parseMigrationFilename,
  planMigrations,
  type AppliedMigration,
  type MigrationFile,
} from './migrator.js';

function file(version: string, sql = `-- ${version}`): MigrationFile {
  return {
    version,
    name: 'test',
    filename: `${version}_test.sql`,
    sql,
    checksum: checksumOf(sql),
  };
}

function applied(file: MigrationFile): AppliedMigration {
  return { version: file.version, checksum: file.checksum };
}

describe('parseMigrationFilename', () => {
  it('accepts a four digit version and a snake case name', () => {
    expect(parseMigrationFilename('0001_identity.sql')).toEqual({
      version: '0001',
      name: 'identity',
    });
  });

  it.each([
    ['1_identity.sql', 'version must be zero padded to four digits'],
    ['0001-identity.sql', 'separator must be an underscore'],
    ['0001_Identity.sql', 'name must be lower case'],
    ['0001_identity.txt', 'must be a .sql file'],
    ['identity.sql', 'must carry a version'],
  ])('rejects %s, because the %s', (filename) => {
    expect(() => parseMigrationFilename(filename)).toThrow(MigrationError);
  });
});

describe('checksumOf', () => {
  it('is stable for the same content', () => {
    expect(checksumOf('select 1;')).toBe(checksumOf('select 1;'));
  });

  it('changes when the content changes', () => {
    expect(checksumOf('select 1;')).not.toBe(checksumOf('select 2;'));
  });

  it('ignores line ending differences', () => {
    // A Windows checkout can rewrite LF to CRLF. A migration must not look edited because of
    // how the repository was cloned.
    expect(checksumOf('select 1;\nselect 2;')).toBe(checksumOf('select 1;\r\nselect 2;'));
  });
});

describe('planMigrations', () => {
  it('treats everything as pending against an empty database', () => {
    const files = [file('0001'), file('0002')];

    const plan = planMigrations(files, []);

    expect(plan.pending.map((f) => f.version)).toEqual(['0001', '0002']);
    expect(plan.alreadyApplied).toEqual([]);
  });

  it('skips what is already applied and keeps the rest pending', () => {
    const first = file('0001');
    const second = file('0002');

    const plan = planMigrations([first, second], [applied(first)]);

    expect(plan.pending.map((f) => f.version)).toEqual(['0002']);
    expect(plan.alreadyApplied).toEqual(['0001']);
  });

  it('reports nothing pending when everything is applied', () => {
    const files = [file('0001'), file('0002')];

    const plan = planMigrations(files, files.map(applied));

    expect(plan.pending).toEqual([]);
    expect(plan.alreadyApplied).toEqual(['0001', '0002']);
  });

  describe('forward only enforcement', () => {
    it('refuses a migration that was edited after being applied', () => {
      const original = file('0001', 'create table a (id int);');
      const edited = file('0001', 'create table a (id bigint);');

      expect(() => planMigrations([edited], [applied(original)])).toThrow(
        /has changed since it was applied/,
      );
    });

    it('refuses when an applied migration file has been deleted', () => {
      const deleted = file('0001');
      const remaining = file('0002');

      expect(() => planMigrations([remaining], [applied(deleted), applied(remaining)])).toThrow(
        /recorded as applied but its file is missing/,
      );
    });

    it('refuses a pending migration numbered below one already applied', () => {
      // Two branches each add a migration; the lower numbered one merges second. Applying it
      // now would order this database differently from one that already ran 0002.
      const late = file('0001');
      const early = file('0002');

      expect(() => planMigrations([late, early], [applied(early)])).toThrow(
        /numbered below 0002, which is already applied/,
      );
    });

    it('allows a pending migration numbered above the highest applied', () => {
      const first = file('0001');
      const second = file('0002');

      const plan = planMigrations([first, second], [applied(first)]);

      expect(plan.pending.map((f) => f.version)).toEqual(['0002']);
    });
  });
});
