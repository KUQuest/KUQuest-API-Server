import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

/**
 * PostgreSQL writes `defaultNow()` timestamps at microsecond precision, and the shared cursor
 * carries a JavaScript `Date` at millisecond precision. A list that compares the cursor
 * millisecond against the column drops every row inside the anchor's millisecond and reports the
 * page complete (#438, #446, #537). A correct list reads the boundary back from the anchor row
 * inside SQL, which leaves a row-wise tuple comparison in the source.
 */
const readsCursorTimestamp = /new Date\((?:cursor|parsed)\.startTime\)/;
const comparesRowWise = /\.id\}\)\s*[<>]/;

/**
 * The keyset mechanics live once, in `src/shared/keyset-page.ts` (Issue #541). A list that builds
 * its own anchor sub-select carries a second copy of the boundary, the probe, and the trim, which
 * is how one defect came to need five fixes (#438, #446, #537).
 */
const buildsAnchorSubSelect = /\(select \$\{[^}]+\}, \$\{[^}]+\} from \$\{/;
const keysetReader = 'src/shared/keyset-page.ts';

/**
 * One page-limit rule holds for the whole API (CODESTYLES.md §Cursor paging, Issue #543): a query
 * schema caps `limit` at `MAX_PAGE_LIMIT` from `src/shared/cursor.ts`, never at a number of its
 * own. A literal in a schema is a second copy of the rule that drifts the next time the maximum
 * moves — one list shipped a cap of 100 beside thirteen caps of 50.
 */
const limitWithNumericMaximum = /limit:\s*t\.Optional\(t\.Integer\(\{[^}]*maximum:\s*(\d+)/g;
const allowedLimitMaximums: Record<string, string> = {
  'src/modules/work-chat/work-chat.schema.ts:20': 'Conversation list pages at DEFAULT_PAGE_LIMIT.',
  'src/modules/work-chat/candidate-inquiry.schema.ts:20':
    'Conversation list pages at DEFAULT_PAGE_LIMIT.',
};

/** Lists that page on `quest.start_time`, which a Hirer supplies at millisecond precision. */
const allowedFiles: Record<string, true> = {
  'src/modules/quest/quest-v2.service.ts': true,
  'src/modules/quest/quest.service.ts': true,
};

const repoRoot = resolve(import.meta.dir, '..', '..');

describe('Cursor paging guard', () => {
  it('pages every timestamp cursor row-wise against the anchor row', async () => {
    const offenders: string[] = [];
    const sources = [
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();
    for (const file of sources) {
      if (allowedFiles[file]) continue;
      const source = await Bun.file(resolve(repoRoot, file)).text();
      if (readsCursorTimestamp.test(source) && !comparesRowWise.test(source)) offenders.push(file);
    }
    const report = offenders
      .map(
        (file) =>
          `${file} builds a page boundary from a millisecond cursor timestamp. Compare row-wise against the anchor row read inside SQL; see src/shared/keyset-page.ts and Issue #537.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });

  it('keeps the keyset anchor sub-select in the shared reader alone', async () => {
    const offenders: string[] = [];
    const sources = [
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();
    for (const file of sources) {
      if (file === keysetReader) continue;
      const source = await Bun.file(resolve(repoRoot, file)).text();
      if (buildsAnchorSubSelect.test(source)) offenders.push(file);
    }
    const report = offenders
      .map(
        (file) =>
          `${file} builds its own keyset anchor sub-select. Page it through readKeysetPage in ${keysetReader}; see Issue #541.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });

  it('caps every query-schema limit at MAX_PAGE_LIMIT', async () => {
    const offenders: string[] = [];
    const sources = [
      ...new Bun.Glob('src/**/*.schema.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();
    for (const file of sources) {
      const source = await Bun.file(resolve(repoRoot, file)).text();
      for (const match of source.matchAll(limitWithNumericMaximum)) {
        if (allowedLimitMaximums[`${file}:${match[1]}`]) continue;
        offenders.push(`${file} caps limit at ${match[1]}`);
      }
    }
    const report = offenders
      .map(
        (line) =>
          `${line}. A query schema caps limit at MAX_PAGE_LIMIT from src/shared/cursor.ts; see CODESTYLES.md §Cursor paging and Issue #543.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });
});
