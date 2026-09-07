import type { PayoutDestinationEncryption } from './payout-destination.crypto';
import type { PayoutDestination } from './payout-destination.service';

/**
 * Provider adapter boundary. Raw destination values must not leave this module.
 */
export type PayoutDestinationForProvider = PayoutDestination & {
  accountNumber: string;
  routingValue: string;
};

type PayoutDestinationEncryptedSecrets = {
  accountNumberKeyVersion: string;
  accountNumberNonce: string;
  accountNumberCiphertext: string;
  accountNumberAuthTag: string;
  routingValueKeyVersion: string;
  routingValueNonce: string;
  routingValueCiphertext: string;
  routingValueAuthTag: string;
};

export const payoutDestinationForProvider = (
  destination: PayoutDestination,
  secrets: PayoutDestinationEncryptedSecrets,
  encryption: PayoutDestinationEncryption,
): PayoutDestinationForProvider => ({
  ...destination,
  accountNumber: encryption.decrypt({
    keyVersion: secrets.accountNumberKeyVersion,
    nonce: secrets.accountNumberNonce,
    ciphertext: secrets.accountNumberCiphertext,
    authTag: secrets.accountNumberAuthTag,
  }),
  routingValue: encryption.decrypt({
    keyVersion: secrets.routingValueKeyVersion,
    nonce: secrets.routingValueNonce,
    ciphertext: secrets.routingValueCiphertext,
    authTag: secrets.routingValueAuthTag,
  }),
});
