import {
  paymentPayoutAccounts,
  paymentPayoutQuotes,
  paymentPayouts,
} from '@/database/schema/payment.schema';

import { describe, expect, it } from 'bun:test';
import { getTableColumns } from 'drizzle-orm';

describe('Payout Destination database schema', () => {
  it('does not define plaintext account or routing columns', () => {
    const destinationColumns = getTableColumns(paymentPayoutAccounts);
    const payoutColumns = getTableColumns(paymentPayouts);

    expect(destinationColumns).not.toHaveProperty('accountNumber');
    expect(destinationColumns).not.toHaveProperty('routingValue');
    expect(destinationColumns).toHaveProperty('accountNumberKeyVersion');
    expect(destinationColumns).toHaveProperty('accountNumberNonce');
    expect(destinationColumns).toHaveProperty('accountNumberCiphertext');
    expect(destinationColumns).toHaveProperty('accountNumberAuthTag');
    expect(destinationColumns).toHaveProperty('routingValueKeyVersion');
    expect(destinationColumns).toHaveProperty('routingValueNonce');
    expect(destinationColumns).toHaveProperty('routingValueCiphertext');
    expect(destinationColumns).toHaveProperty('routingValueAuthTag');
    expect(destinationColumns).toHaveProperty('maskedRoutingValue');

    expect(payoutColumns).not.toHaveProperty('destinationAccountNumber');
    expect(payoutColumns).not.toHaveProperty('destinationRoutingValue');
  });

  it('stores Payout amounts and provider facts as integer Satang', () => {
    const quoteColumns = getTableColumns(paymentPayoutQuotes);
    const payoutColumns = getTableColumns(paymentPayouts);

    for (const name of ['receiptSatang', 'maximumFeeSatang', 'maximumTaxSatang', 'maximumDebitSatang']) {
      expect(quoteColumns[name as keyof typeof quoteColumns].dataType).toBe('number');
    }
    for (const name of [
      'principalSatang',
      'maximumFeeSatang',
      'maximumTaxSatang',
      'maximumDebitSatang',
      'providerAmountSatang',
      'actualFeeSatang',
      'actualTaxSatang',
      'actualDebitSatang',
    ]) {
      expect(payoutColumns[name as keyof typeof payoutColumns].dataType).toBe('number');
    }
    expect(Object.keys(quoteColumns).some((name) => name.toLowerCase().includes('baht'))).toBe(false);
    expect(Object.keys(payoutColumns).some((name) => name.toLowerCase().includes('baht'))).toBe(false);
  });
});
