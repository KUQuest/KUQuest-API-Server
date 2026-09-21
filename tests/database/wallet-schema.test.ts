import {
  paymentMoneyPolicyRevision,
  walletEarningsConversion,
  walletLedgerAccount,
  walletLedgerPosting,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

describe('Wallet & Payments database schema', () => {
  it('stores all Wallet balances and postings as integer satang', () => {
    const walletColumns = getTableColumns(walletWallet);
    const postingColumns = getTableColumns(walletLedgerPosting);

    expect(walletColumns.spendingBalanceSatang.dataType).toBe('number');
    expect(walletColumns.earningsBalanceSatang.dataType).toBe('number');
    expect(walletColumns.fundingReservedSatang.dataType).toBe('number');
    expect(walletColumns.reservedForPayoutsSatang.dataType).toBe('number');
    expect(postingColumns.amountSatang.dataType).toBe('number');
  });

  it('uses compact integer policy controls', () => {
    const columns = getTableColumns(paymentMoneyPolicyRevision);

    expect(columns.revision.dataType).toBe('number');
    expect(columns.quoteLifetimeSeconds.dataType).toBe('number');
    expect(columns.minimumFundingReservationSatang.dataType).toBe('number');
    expect(columns).not.toHaveProperty('reviewWindowSeconds');
    expect(columns).not.toHaveProperty('defaultApplicationWindowSeconds');
  });

  it('derives a Wallet account owner through its Wallet reference', () => {
    const columns = getTableColumns(walletLedgerAccount);

    expect(columns).toHaveProperty('walletId');
    expect(columns).not.toHaveProperty('userId');
  });

  it('stores the Earnings Conversion domain record in satang and links it to the ledger', () => {
    const columns = getTableColumns(walletEarningsConversion);

    expect(columns.amountSatang.dataType).toBe('number');
    expect(columns).toHaveProperty('ledgerTransactionId');
    expect(columns).toHaveProperty('idempotencyKeyId');
  });
});
