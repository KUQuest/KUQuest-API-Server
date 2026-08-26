import { paymentPayoutAccounts, paymentPayouts } from '@/database/schema/payment.schema';

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

    expect(payoutColumns).not.toHaveProperty('destinationAccountNumber');
    expect(payoutColumns).not.toHaveProperty('destinationRoutingValue');
  });
});
