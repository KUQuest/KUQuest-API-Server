import { db } from '@/database/client';
import { paymentPayoutAccounts } from '@/database/schema/payment.schema';

import { and, eq } from 'drizzle-orm';

import {
  createPayoutDestinationEncryption,
  type PayoutDestinationEncryption,
} from './payout-destination.crypto';
import {
  destinationFromRecord,
  type PayoutDestination,
} from './payout-destination.service';

/**
 * Provider adapter boundary. Raw destination values must not leave this module.
 */
export type PayoutDestinationForProvider = PayoutDestination & {
  accountNumber: string;
  routingValue: string;
};

const providerDestinationFromRecord = (
  record: typeof paymentPayoutAccounts.$inferSelect,
  encryption: PayoutDestinationEncryption,
): PayoutDestinationForProvider => {
  const destination = destinationFromRecord(record);
  const accountNumber = encryption.decrypt({
    keyVersion: record.accountNumberKeyVersion,
    nonce: record.accountNumberNonce,
    ciphertext: record.accountNumberCiphertext,
    authTag: record.accountNumberAuthTag,
  });
  const routingValue = encryption.decrypt({
    keyVersion: record.routingValueKeyVersion,
    nonce: record.routingValueNonce,
    ciphertext: record.routingValueCiphertext,
    authTag: record.routingValueAuthTag,
  });

  return { ...destination, accountNumber, routingValue };
};

export const getPayoutDestinationForProvider = async (
  principalUserId: string,
  destinationId: string,
  encryption: PayoutDestinationEncryption = createPayoutDestinationEncryption(),
): Promise<PayoutDestinationForProvider | undefined> => {
  const [record] = await db
    .select()
    .from(paymentPayoutAccounts)
    .where(and(eq(paymentPayoutAccounts.userId, principalUserId), eq(paymentPayoutAccounts.id, destinationId)))
    .limit(1);

  return record ? providerDestinationFromRecord(record, encryption) : undefined;
};
