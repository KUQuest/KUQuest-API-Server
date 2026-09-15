import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

const allowedFiles: Record<string, true> = {
  'src/database/schema/wallet.schema.ts': true,
  'src/modules/wallet/wallet.money-command.service.ts': true,
};

const digestAllowedFiles: Record<string, true> = {
  // The one shared Finance request digest.
  'src/modules/wallet/wallet.money-command.service.ts': true,
  // Quest owns its own command records and their digest (ADR-0029). Importing the Wallet
  // helper here would add the Quest-to-Wallet import that ADR-0009 and ADR-0030 remove.
  'src/modules/quest/quest-command.service.ts': true,
};

const boundaryAllowedFiles: Record<string, true> = {
  // The barrel re-exports walletRoute, which imports @/modules/auth, so a barrel import cycles.
  'src/modules/auth/auth.config.ts': true,
  // Takes the Elysia schema walletBalanceSchema, which the barrel does not export.
  'src/modules/local-finance-test/local-finance-test.schema.ts': true,
  // Provider adapters that take only money value types from wallet.money.
  'src/modules/payout/payout.provider-event.ts': true,
  'src/modules/payout/payout.provider.ts': true,
  'src/modules/top-up/top-up.provider-event.ts': true,
  'src/modules/top-up/top-up.provider.ts': true,
};

const repoRoot = resolve(import.meta.dir, '..', '..', '..');

/**
 * Scans every source file the guard covers and collects the ones that offend, with the
 * report line each offender earns. `skip` drops a file before it is read at all.
 */
const scanSources = async (
  offends: (source: string) => boolean,
  reportFor: (file: string) => string,
  skip: (file: string) => boolean
) => {
  const offenders: string[] = [];
  const sources = [
    ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
  ].sort();
  for (const file of sources) {
    if (skip(file)) continue;
    const source = await Bun.file(resolve(repoRoot, file)).text();
    if (offends(source)) offenders.push(file);
  }
  return { offenders, report: offenders.map(reportFor).join('\n') };
};

describe('Money Command guard', () => {
  it('names walletIdempotencyKey only in the protocol and schema files', async () => {
    const { offenders, report } = await scanSources(
      (source) => source.includes('walletIdempotencyKey'),
      (file) =>
        `${file} uses walletIdempotencyKey directly. Route the money command through runMoneyCommand in src/modules/wallet/wallet.money-command.service.ts; see docs/adr/0032-unified-money-command-protocol.md.`,
      (file) => allowedFiles[file] === true
    );

    expect(offenders, report).toEqual([]);
  });

  it('defines sha256Json only in the money command module', async () => {
    const { offenders, report } = await scanSources(
      (source) => source.includes('const sha256Json'),
      (file) =>
        `${file} defines its own sha256Json. Import the shared sha256Json from '@/modules/wallet' (or from './wallet.money-command.service' inside the Wallet module); see docs/adr/0032-unified-money-command-protocol.md.`,
      (file) => digestAllowedFiles[file] === true
    );

    expect(offenders, report).toEqual([]);
  });

  it('imports the Wallet module only through its boundary', async () => {
    const { offenders, report } = await scanSources(
      (source) => source.includes('@/modules/wallet/'),
      (file) =>
        `${file} reaches into the Wallet module by deep path. Import from the '@/modules/wallet' boundary instead.`,
      // Wallet's own files legitimately use relative imports.
      (file) => file.startsWith('src/modules/wallet/') || boundaryAllowedFiles[file] === true
    );

    expect(offenders, report).toEqual([]);
  });

  it('keeps every exported function in wallet.service consumed by at least one other file', async () => {
    const walletServiceFile = 'src/modules/wallet/wallet.service.ts';
    const text = await Bun.file(resolve(repoRoot, walletServiceFile)).text();
    const exportedFunctions = [
      ...text.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/g),
    ].map((match) => match[1]);

    const allSources = await Promise.all(
      [...new Bun.Glob('{src,tests}/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true })].map(
        async (file) => ({
          file,
          text: await Bun.file(resolve(repoRoot, file)).text(),
        })
      )
    );

    const offenders: string[] = [];

    for (const fn of exportedFunctions) {
      const boundary = new RegExp(`\\b${fn}\\b`);
      const isConsumed = allSources.some(
        (source) => source.file !== walletServiceFile && boundary.test(source.text)
      );
      if (!isConsumed) {
        offenders.push(fn);
      }
    }

    const report = offenders
      .map(
        (fn) =>
          `wallet.service.ts exports ${fn}, but no other file imports it. Remove the unused export.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });
});
