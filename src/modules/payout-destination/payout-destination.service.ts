import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { paymentPayoutAccounts } from '@/database/schema/payment.schema';

import { and, eq, isNull } from 'drizzle-orm';

import {
  createPayoutDestinationEncryption,
  PayoutDestinationEncryptionError,
  type PayoutDestinationEncryptedSecret,
  type PayoutDestinationEncryption,
} from './payout-destination.crypto';

export type PayoutDestinationErrorCode =
  | 'PAYOUT_DESTINATION_INVALID'
  | 'PAYOUT_DESTINATION_MEMBER_NOT_FOUND'
  | 'PAYOUT_DESTINATION_PERSISTENCE_FAILED';

export class PayoutDestinationError extends Error {
  readonly code: PayoutDestinationErrorCode;

  constructor(code: PayoutDestinationErrorCode, message: string) {
    super(message);
    this.name = 'PayoutDestinationError';
    this.code = code;
  }
}

export type PayoutDestinationInput = {
  principalUserId: string;
  recipientType?: string;
  givenName: string;
  surname: string;
  relationship: string;
  accountCountry?: string;
  accountCurrency?: string;
  bankCode: string;
  accountNumber: string;
  accountHolderName: string;
  routingType: string;
  routingValue: string;
};

export type PayoutDestination = {
  id: string;
  principalUserId: string;
  recipientType: 'SELF';
  givenName: string;
  surname: string;
  relationship: string;
  accountCountry: 'TH';
  accountCurrency: 'THB';
  bankCode: string;
  accountHolderName: string;
  routingType: 'BANK_ACCOUNT' | 'PROMPTPAY';
  maskedLastFour: string;
  createdAt: Date;
  retiredAt: Date | null;
};

export type PayoutDestinationForProvider = PayoutDestination & {
  accountNumber: string;
  routingValue: string;
};

const requiredText = (value: string | undefined) => typeof value === 'string' && value.trim().length > 0;

const normalizeInput = (input: PayoutDestinationInput) => {
  const accountCountry = input.accountCountry ?? 'TH';
  const accountCurrency = input.accountCurrency ?? 'THB';
  const recipientType = input.recipientType ?? 'SELF';

  if (
    recipientType !== 'SELF' ||
    accountCountry !== 'TH' ||
    accountCurrency !== 'THB' ||
    !['BANK_ACCOUNT', 'PROMPTPAY'].includes(input.routingType) ||
    !requiredText(input.principalUserId) ||
    !requiredText(input.givenName) ||
    !requiredText(input.surname) ||
    !requiredText(input.relationship) ||
    !requiredText(input.bankCode) ||
    !requiredText(input.accountNumber) ||
    !requiredText(input.accountHolderName) ||
    !requiredText(input.routingValue)
  ) {
    throw new PayoutDestinationError(
      'PAYOUT_DESTINATION_INVALID',
      'Payout Destination data is invalid.',
    );
  }

  const accountNumber = input.accountNumber.trim();
  const routingValue = input.routingValue.trim();
  if (accountNumber.length < 4 || routingValue.length < 4) {
    throw new PayoutDestinationError(
      'PAYOUT_DESTINATION_INVALID',
      'Payout Destination data is invalid.',
    );
  }

  return {
    principalUserId: input.principalUserId.trim(),
    recipientType: 'SELF' as const,
    givenName: input.givenName.trim(),
    surname: input.surname.trim(),
    relationship: input.relationship.trim(),
    accountCountry: 'TH' as const,
    accountCurrency: 'THB' as const,
    bankCode: input.bankCode.trim(),
    accountNumber,
    accountHolderName: input.accountHolderName.trim(),
    routingType: input.routingType as 'BANK_ACCOUNT' | 'PROMPTPAY',
    routingValue,
  };
};

const encryptedDestinationSecrets = (
  accountNumber: PayoutDestinationEncryptedSecret,
  routingValue: PayoutDestinationEncryptedSecret,
) => ({
  accountNumberKeyVersion: accountNumber.keyVersion,
  accountNumberNonce: accountNumber.nonce,
  accountNumberCiphertext: accountNumber.ciphertext,
  accountNumberAuthTag: accountNumber.authTag,
  routingValueKeyVersion: routingValue.keyVersion,
  routingValueNonce: routingValue.nonce,
  routingValueCiphertext: routingValue.ciphertext,
  routingValueAuthTag: routingValue.authTag,
});

const destinationFromRecord = (
  record: typeof paymentPayoutAccounts.$inferSelect,
): PayoutDestination => ({
  id: record.id,
  principalUserId: record.userId,
  recipientType: 'SELF',
  givenName: record.givenName,
  surname: record.surname,
  relationship: record.relationship,
  accountCountry: 'TH',
  accountCurrency: 'THB',
  bankCode: record.bankCode,
  accountHolderName: record.accountHolderName,
  routingType: record.routingType as 'BANK_ACCOUNT' | 'PROMPTPAY',
  maskedLastFour: record.maskedLastFour,
  createdAt: record.createdAt,
  retiredAt: record.retiredAt,
});

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

const encryptSecret = (encryption: PayoutDestinationEncryption, value: string) => {
  try {
    return encryption.encrypt(value);
  } catch (error) {
    if (error instanceof PayoutDestinationEncryptionError) throw error;
    throw new PayoutDestinationEncryptionError(
      'PAYOUT_DESTINATION_ENCRYPTION_FAILED',
      'Payout Destination encryption failed.',
    );
  }
};

const activeDestinationWhere = (principalUserId: string, destinationId?: string) =>
  destinationId
    ? and(
      eq(paymentPayoutAccounts.userId, principalUserId),
      eq(paymentPayoutAccounts.id, destinationId),
      isNull(paymentPayoutAccounts.retiredAt),
    )
    : and(eq(paymentPayoutAccounts.userId, principalUserId), isNull(paymentPayoutAccounts.retiredAt));

export const savePayoutDestination = async (
  input: PayoutDestinationInput,
  encryption: PayoutDestinationEncryption = createPayoutDestinationEncryption(),
): Promise<PayoutDestination> => {
  const normalized = normalizeInput(input);
  const accountNumberSecret = encryptSecret(encryption, normalized.accountNumber);
  const routingValueSecret = encryptSecret(encryption, normalized.routingValue);

  try {
    return await db.transaction(async (transaction) => {
      const [member] = await transaction
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.id, normalized.principalUserId))
        .for('update');
      if (!member) {
        throw new PayoutDestinationError(
          'PAYOUT_DESTINATION_MEMBER_NOT_FOUND',
          'Member does not exist.',
        );
      }

      const [previous] = await transaction
        .select()
        .from(paymentPayoutAccounts)
        .where(activeDestinationWhere(normalized.principalUserId))
        .for('update');
      if (previous) {
        await transaction
          .update(paymentPayoutAccounts)
          .set({ retiredAt: new Date() })
          .where(eq(paymentPayoutAccounts.id, previous.id));
      }

      const values: typeof paymentPayoutAccounts.$inferInsert = {
        userId: normalized.principalUserId,
        recipientType: normalized.recipientType,
        givenName: normalized.givenName,
        surname: normalized.surname,
        relationship: normalized.relationship,
        accountCountry: normalized.accountCountry,
        accountCurrency: normalized.accountCurrency,
        bankCode: normalized.bankCode,
        accountHolderName: normalized.accountHolderName,
        routingType: normalized.routingType,
        ...encryptedDestinationSecrets(accountNumberSecret, routingValueSecret),
        maskedLastFour: normalized.accountNumber.slice(-4),
      };
      const [created] = await transaction
        .insert(paymentPayoutAccounts)
        .values(values)
        .returning();
      if (!created) {
        throw new PayoutDestinationError(
          'PAYOUT_DESTINATION_PERSISTENCE_FAILED',
          'Payout Destination could not be saved.',
        );
      }

      return destinationFromRecord(created);
    });
  } catch (error) {
    if (error instanceof PayoutDestinationError || error instanceof PayoutDestinationEncryptionError) {
      throw error;
    }
    throw new PayoutDestinationError(
      'PAYOUT_DESTINATION_PERSISTENCE_FAILED',
      'Payout Destination could not be saved.',
    );
  }
};

export const getPayoutDestination = async (
  principalUserId: string,
  destinationId?: string,
): Promise<PayoutDestination | undefined> => {
  const [record] = await db
    .select()
    .from(paymentPayoutAccounts)
    .where(
      destinationId
        ? and(eq(paymentPayoutAccounts.userId, principalUserId), eq(paymentPayoutAccounts.id, destinationId))
        : activeDestinationWhere(principalUserId),
    )
    .limit(1);

  return record ? destinationFromRecord(record) : undefined;
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

export const retirePayoutDestination = async (
  principalUserId: string,
  destinationId?: string,
): Promise<PayoutDestination | undefined> => {
  try {
    const [retired] = await db.transaction(async (transaction) => {
      const [member] = await transaction
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.id, principalUserId))
        .for('update');
      if (!member) return [];

      const [active] = await transaction
        .select()
        .from(paymentPayoutAccounts)
        .where(activeDestinationWhere(principalUserId, destinationId))
        .for('update');
      if (!active) return [];

      return transaction
        .update(paymentPayoutAccounts)
        .set({ retiredAt: new Date() })
        .where(eq(paymentPayoutAccounts.id, active.id))
        .returning();
    });

    return retired ? destinationFromRecord(retired) : undefined;
  } catch (error) {
    if (error instanceof PayoutDestinationError) throw error;
    throw new PayoutDestinationError(
      'PAYOUT_DESTINATION_PERSISTENCE_FAILED',
      'Payout Destination could not be retired.',
    );
  }
};
