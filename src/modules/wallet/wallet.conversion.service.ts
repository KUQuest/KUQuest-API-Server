import { db } from '@/database/client';
import {
  walletEarningsConversion,
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { and, eq, inArray } from 'drizzle-orm';

import {
  MoneyDomainError,
  type Satang,
  positiveSatang,
  satang,
  signedSatang,
} from './wallet.money';
import { completeMoneyCommand, runMoneyCommand, sha256Json } from './wallet.money-command.service';
import { assertWalletOperationAllowed } from './wallet.status.service';
import {
  createSealedLedgerTransactionInTransaction,
  ensureWalletInTransaction,
  getEffectiveMoneyPolicyWith,
  validateOperationAmount,
  type WalletTransaction,
} from './wallet.service';

export const earningsConversionScope = 'wallet.earnings-conversion';

type EarningsConversionIdempotency = {
  key: string;
};

export type EarningsConversionInput = {
  principalUserId: string;
  amountSatang: Satang;
  idempotency: EarningsConversionIdempotency;
};

export type EarningsConversion = {
  id: string;
  principalUserId: string;
  amountSatang: Satang;
  businessReference: string;
  ledgerTransactionId: string;
  createdAt: Date;
};

const conversionBusinessReference = async (principalUserId: string, key: string) =>
  `${earningsConversionScope}:${await sha256Json({ principalUserId, key })}`;

const conversionRequestHash = (amountSatang: number) => sha256Json({ amountSatang });

const conversionFromRecord = (
  record: typeof walletEarningsConversion.$inferSelect
): EarningsConversion => ({
  id: record.id,
  principalUserId: record.principalUserId,
  amountSatang: positiveSatang(record.amountSatang),
  businessReference: record.businessReference,
  ledgerTransactionId: record.ledgerTransactionId,
  createdAt: record.createdAt,
});

const getEarningsConversionAccounts = async (transaction: WalletTransaction, walletId: string) => {
  const accounts = await transaction
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .where(
      and(
        eq(walletLedgerAccount.walletId, walletId),
        inArray(walletLedgerAccount.type, ['SPENDING', 'EARNINGS'])
      )
    );
  const spending = accounts.find(({ type }) => type === 'SPENDING');
  const earnings = accounts.find(({ type }) => type === 'EARNINGS');
  if (!spending || !earnings) {
    throw new MoneyDomainError('WALLET_PROVISION_FAILED', 'Wallet ledger accounts are incomplete.');
  }
  return { spendingId: spending.id, earningsId: earnings.id };
};

export const convertEarnings = async (input: EarningsConversionInput) => {
  const businessReference = await conversionBusinessReference(
    input.principalUserId,
    input.idempotency.key
  );
  const requestHash = await conversionRequestHash(input.amountSatang);

  return db.transaction(async (transaction) => {
    const { result } = await runMoneyCommand(
      transaction,
      {
        principalUserId: input.principalUserId,
        scope: earningsConversionScope,
        key: input.idempotency.key,
        requestHash,
      },
      {
        execute: async (transaction, keyId) => {
          await ensureWalletInTransaction(transaction, input.principalUserId);
          const [wallet] = await transaction
            .select()
            .from(walletWallet)
            .where(eq(walletWallet.userId, input.principalUserId))
            .for('update');
          if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
          assertWalletOperationAllowed(wallet.walletStatus, 'EARNINGS_CONVERSION');

          const policy = await getEffectiveMoneyPolicyWith(transaction);
          const amount = validateOperationAmount(
            input.amountSatang,
            Number(policy.minimumEarningsConversionSatang),
            Number(policy.maximumEarningsConversionSatang)
          );
          const earningsBalance = satang(wallet.earningsBalanceSatang);
          if (earningsBalance < amount) {
            throw new MoneyDomainError(
              'INSUFFICIENT_EARNINGS_BALANCE',
              'The Wallet has insufficient Earnings Balance.'
            );
          }

          const { spendingId, earningsId } = await getEarningsConversionAccounts(
            transaction,
            wallet.id
          );
          const ledgerTransaction = await createSealedLedgerTransactionInTransaction(transaction, {
            businessReference,
            eventType: 'EARNINGS_CONVERSION',
            createdByUserId: input.principalUserId,
            description: 'Earnings converted to Spending Balance',
            idempotencyKeyId: keyId,
            postings: [
              { accountId: earningsId, amountSatang: signedSatang(-amount) },
              { accountId: spendingId, amountSatang: signedSatang(amount) },
            ],
          });
          if (!ledgerTransaction) {
            throw new MoneyDomainError(
              'LEDGER_CREATE_FAILED',
              'Earnings Conversion ledger transaction could not be created.'
            );
          }

          const [conversionRecord] = await transaction
            .insert(walletEarningsConversion)
            .values({
              principalUserId: input.principalUserId,
              amountSatang: amount,
              businessReference,
              ledgerTransactionId: ledgerTransaction.id,
              idempotencyKeyId: keyId,
            })
            .returning();
          if (!conversionRecord) {
            throw new MoneyDomainError(
              'LEDGER_CREATE_FAILED',
              'Earnings Conversion record could not be created.'
            );
          }

          await completeMoneyCommand(
            transaction,
            keyId,
            'wallet_earnings_conversion',
            conversionRecord.id
          );

          return conversionFromRecord(conversionRecord);
        },
        replay: async (transaction, keyRow) => {
          if (!keyRow.resourceId) {
            throw new MoneyDomainError(
              'IDEMPOTENCY_UNAVAILABLE',
              'The idempotent conversion record is missing.'
            );
          }
          const [original] = await transaction
            .select()
            .from(walletEarningsConversion)
            .where(eq(walletEarningsConversion.id, keyRow.resourceId));
          if (!original) {
            throw new MoneyDomainError(
              'IDEMPOTENCY_UNAVAILABLE',
              'The idempotent conversion record is missing.'
            );
          }
          return conversionFromRecord(original);
        },
      }
    );
    return result;
  });
};
