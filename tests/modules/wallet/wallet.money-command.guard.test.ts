import { resolve } from 'node:path';

import { describe, expect, it } from 'bun:test';

// ADR-0032 keeps the Money Command protocol as the only owner of
// `wallet_idempotency_keys`: a money service routes through `runMoneyCommand`
// instead of holding its own copy of the acquire-or-replay mechanics. Only the
// schema definition and the protocol implementation name the table.
const allowedFiles: Record<string, true> = {
  'src/database/schema/wallet.schema.ts': true,
  'src/modules/wallet/wallet.money-command.service.ts': true,
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
});
