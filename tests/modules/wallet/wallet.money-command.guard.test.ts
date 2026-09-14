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

describe('Money Command guard', () => {
  it('names walletIdempotencyKey only in the protocol and schema files', async () => {
    const offenders: string[] = [];
    const sources = [
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();
    for (const file of sources) {
      if (allowedFiles[file]) continue;
      const source = await Bun.file(resolve(repoRoot, file)).text();
      if (source.includes('walletIdempotencyKey')) offenders.push(file);
    }
    const report = offenders
      .map(
        (file) =>
          `${file} uses walletIdempotencyKey directly. Route the money command through runMoneyCommand in src/modules/wallet/wallet.money-command.service.ts; see docs/adr/0032-unified-money-command-protocol.md.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });

  it('defines sha256Json only in the money command module', async () => {
    const offenders: string[] = [];
    const sources = [
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();
    for (const file of sources) {
      if (digestAllowedFiles[file]) continue;
      const source = await Bun.file(resolve(repoRoot, file)).text();
      if (source.includes('const sha256Json')) offenders.push(file);
    }
    const report = offenders
      .map(
        (file) =>
          `${file} defines its own sha256Json. Import the shared sha256Json from '@/modules/wallet' (or from './wallet.money-command.service' inside the Wallet module); see docs/adr/0032-unified-money-command-protocol.md.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });

  it('imports the Wallet module only through its boundary', async () => {
    const offenders: string[] = [];
    const sources = [
      ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: repoRoot, onlyFiles: true }),
    ].sort();
    for (const file of sources) {
      if (file.startsWith('src/modules/wallet/')) continue; // Wallet's own files legitimately use relative imports
      if (boundaryAllowedFiles[file]) continue;
      const source = await Bun.file(resolve(repoRoot, file)).text();
      if (source.includes('@/modules/wallet/')) offenders.push(file);
    }
    const report = offenders
      .map(
        (file) =>
          `${file} reaches into the Wallet module by deep path. Import from the '@/modules/wallet' boundary instead.`
      )
      .join('\n');

    expect(offenders, report).toEqual([]);
  });
});
