import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

const repoRoot = resolve(import.meta.dir, '..', '..', '..');
const questImport = /from\s+['"](@\/modules\/quest[^'"]*)['"]/g;
const allowedQuestImports: Record<string, string> = {
  '@/modules/quest/shared/title':
    'The Quest barrel loads Quest services that read Wallet exports; a runtime import from Wallet fails with "Cannot access questStatus before initialization". This leaf imports only the database and schema.',
};

describe('Wallet Quest import boundary', () => {
  it('lets Wallet import only documented Quest leaf paths', async () => {
    const files = [
      ...new Bun.Glob('src/modules/wallet/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ];
    const sources = await Promise.all(
      files.map(async (file) => ({ file, source: await Bun.file(resolve(repoRoot, file)).text() }))
    );
    const offenders = sources.flatMap(({ file, source }) =>
      [...source.matchAll(questImport)]
        .filter(([, path]) => !allowedQuestImports[path ?? ''])
        .map(
          ([, path]) =>
            `${file} imports ${path}; only ${Object.keys(allowedQuestImports)} is allowed.`
        )
    );

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
