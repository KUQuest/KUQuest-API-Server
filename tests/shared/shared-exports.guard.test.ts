import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

const repoRoot = resolve(import.meta.dir, '..', '..');

/**
 * Allowlist for exported symbols in `src/shared/` that have no direct cross-file references.
 * Every entry must specify an explicit, documented justification.
 */
const allowedUnreferencedExports: Record<string, string> = {
  'src/shared/api-response.schema.ts:apiErrorSchema':
    'Error response schema export for OpenAPI schema composition',
  'src/shared/api-response.ts:ApiSuccess': 'Top-level API response envelope type',
  'src/shared/keyset-page.ts:KeysetAnchor':
    'Anchor tuple contract type for keyset pagination callers',
  'src/shared/keyset-page.ts:KeysetPage': 'Page envelope return type for keyset pagination callers',
  'src/shared/keyset-page.ts:KeysetPageRequest':
    'Request payload type for keyset pagination callers',
  'src/shared/object-storage.ts:FileUploadPlan':
    'Upload plan type alias for pre-planned upload flows',
  'src/shared/object-storage.ts:ImageContentType':
    'Narrowed image content type union for callers asserting image types',
  'src/shared/object-storage.ts:ObjectStorageConfig':
    'Configuration options type for createObjectStorage',
  'src/shared/object-storage.ts:StorageContentPolicy': 'Content policy configuration literal type',
  'src/shared/object-storage.ts:StorageContentType': 'Storage content type union alias',
  'src/shared/resource-version.ts:ResourceVersion': 'Nominal resource version type contract',
};

describe('Shared module exports guard', () => {
  it('keeps every symbol exported from src/shared referenced or explicitly allowlisted', async () => {
    const sharedFiles = [
      ...new Bun.Glob('src/shared/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();

    const allSources = await Promise.all(
      [...new Bun.Glob('{src,tests}/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true })].map(
        async (file) => ({
          file,
          text: await Bun.file(resolve(repoRoot, file)).text(),
        })
      )
    );

    const offenders: string[] = [];

    for (const file of sharedFiles) {
      const text = await Bun.file(resolve(repoRoot, file)).text();
      const exportedSymbols = [
        ...text.matchAll(/export\s+(?:type|const|class|function|interface)\s+([A-Za-z0-9_]+)/g),
      ].map((match) => match[1]);

      const uniqueExports = [...new Set(exportedSymbols)];

      for (const symbol of uniqueExports) {
        const key = `${file}:${symbol}`;
        if (allowedUnreferencedExports[key]) continue;

        const symbolBoundary = new RegExp(`\\b${symbol}\\b`);
        const isReferenced = allSources.some(
          (source) => source.file !== file && symbolBoundary.test(source.text)
        );

        if (!isReferenced) {
          offenders.push(key);
        }
      }
    }

    const report = offenders
      .map(
        (key) =>
          `${key} has no importers outside its definition file. Remove the unused export or allowlist it with a reason.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });
});
