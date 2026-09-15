import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

/**
 * #497 moved every Quest money assertion to the test seam, and the acceptance criterion was a
 * repository search. A search proves a state at one moment, so this guard holds the rule: a Quest
 * test reads a Wallet, a balance, a Funding Reservation, or a Ledger Transaction through
 * `tests/modules/wallet/wallet-test-fixtures.ts`. Direct reads drifted into 27 local helpers
 * before #489 counted them.
 */
const walletSchemaImport = '@/database/schema/wallet.schema';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
/** This file names the import to detect it, so it excludes itself. */
const guardFile = 'tests/modules/quest/quest.money-seam.guard.test.ts';

describe('Quest money seam guard', () => {
  it('asserts Quest money outcomes through the test seam', async () => {
    const offenders: string[] = [];
    const sources = [
      ...new Bun.Glob('tests/modules/quest/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();
    for (const file of sources) {
      if (file === guardFile) continue;
      const source = await Bun.file(resolve(repoRoot, file)).text();
      if (source.includes(walletSchemaImport)) offenders.push(file);
    }
    const report = offenders
      .map(
        (file) =>
          `${file} reads the Wallet schema directly. Assert the money outcome through tests/modules/wallet/wallet-test-fixtures.ts; see Issue #497.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });
});
