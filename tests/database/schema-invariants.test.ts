import { describe, expect, test } from 'bun:test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { user } from '../../src/database/schema/auth.schema';
import { jobs } from '../../src/database/schema/jobs.schema';
import { ledgerPostings, ledgerTransactions, wallets } from '../../src/database/schema/ledger.schema';
import { moneyPolicyRevisions, payouts, topUps } from '../../src/database/schema/payments.schema';

describe('approved database schema', () => {
  test('preserves Better Auth table and identifier names', () => {
    const config = getTableConfig(user);
    expect(config.name).toBe('user');
    expect(user.id.name).toBe('user_id');
    expect(user.id.dataType).toBe('string');
  });

  test('uses explicit whole-baht wallet and ledger units', () => {
    expect(Object.values(wallets).map((column) => column.name)).toEqual(expect.arrayContaining([
      'spending_balance_baht', 'earnings_balance_baht', 'held_for_jobs_baht', 'reserved_for_payouts_baht',
    ]));
    expect(ledgerPostings.amountBaht.name).toBe('amount_baht');
    expect(ledgerTransactions.sealedAt.name).toBe('sealed_at');
  });

  test('snapshots job fees and provider amounts without floating point', () => {
    expect(jobs.platformFeeBps.name).toBe('platform_fee_bps');
    expect(jobs.platformFeeBaht.name).toBe('platform_fee_baht');
    expect(jobs.workerNetBaht.name).toBe('worker_net_baht');
    expect(topUps.providerFeeSatang.name).toBe('provider_fee_satang');
    expect(topUps.chargedFeeBaht.name).toBe('charged_fee_baht');
    expect(payouts.actualDebitSatang.name).toBe('actual_debit_satang');
  });

  test('contains every policy range required by the API contract', () => {
    const names = Object.values(moneyPolicyRevisions).map((column) => column.name);
    for (const domain of ['top_up', 'funded_job', 'earnings_conversion', 'payout']) {
      expect(names).toContain(`minimum_${domain}_baht`);
      expect(names).toContain(`maximum_${domain}_baht`);
    }
  });
});
