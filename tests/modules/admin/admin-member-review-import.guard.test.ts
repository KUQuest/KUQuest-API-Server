import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const allowedReviewQueryImports: Record<string, string> = {
  'src/modules/admin/admin-member.service.ts':
    'The Quest shared barrel exports Escrow, which reaches the Wallet and Admin barrels and cycles back to Admin Member.',
  'src/modules/quest/v1/services/quest-review.service.ts':
    'Use the sibling Review service directly; the Quest shared barrel loads Escrow, Wallet, and Admin routes.',
};
const ratingReviewServiceImport = /from\s+['"][^'"]*rating-review\.service['"]/;
const questSharedBarrelImport = /from\s+['"]@\/modules\/quest\/shared['"]/;

describe('Rating Review service import boundary', () => {
  it('keeps the known Quest shared barrel cycle on documented direct imports', async () => {
    const sourceFiles = [
      ...new Bun.Glob('src/**/*.ts').scanSync({
        cwd: repoRoot,
        onlyFiles: true,
      }),
    ];
    const sources = await Promise.all(
      sourceFiles.map(async (file) => ({
        file,
        source: await Bun.file(resolve(repoRoot, file)).text(),
      }))
    );
    const foundAllowedImports = new Set<string>();
    const offenders: string[] = [];

    for (const { file, source } of sources) {
      if (ratingReviewServiceImport.test(source)) {
        if (allowedReviewQueryImports[file]) {
          foundAllowedImports.add(file);
        } else {
          offenders.push(`${file} imports the internal Rating Review query service.`);
        }
      }
      if (file.startsWith('src/modules/admin/') && questSharedBarrelImport.test(source)) {
        offenders.push(`${file} imports the Quest shared barrel and recreates the Admin cycle.`);
      }
    }

    for (const [file, reason] of Object.entries(allowedReviewQueryImports)) {
      if (!foundAllowedImports.has(file)) {
        offenders.push(`${file} has a stale import exception: ${reason}`);
      }
    }

    const report = offenders.join('\n');
    expect(offenders, report).toEqual([]);
  });
});
