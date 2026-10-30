import { describe, expect, it } from 'bun:test';

describe('Member Penalty import boundary', () => {
  it('imports Wallet services below the barrel to avoid the Auth initialization cycle', async () => {
    // The Wallet barrel exports wallet.route; that route imports authGuard, whose auth config
    // imports Member Penalty. Importing the barrel here creates a runtime cycle.
    const service = await Bun.file(
      new URL(
        '../../../src/modules/admin/member-penalty/member-penalty.service.ts',
        import.meta.url
      )
    ).text();

    expect(service).toContain("from '@/modules/wallet/wallet.status.service'");
    expect(service).toContain("from '@/modules/wallet/wallet.service'");
    expect(service).not.toContain("from '@/modules/wallet'");
  });
});
