import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  type LedgerEventType,
  paymentMoneyPolicyRevision,
  walletActivity,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletIdempotencyKey,
  walletStatusHistory,
  walletWallet,
} from '@/database/schema/wallet.schema';

import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import {
  MAX_OPERATION_SATANG,
  MAX_WALLET_CAPACITY_SATANG,
  MoneyDomainError,
  type Satang,
  type SignedSatang,
  positiveSatang,
  satang,
  satangDelta,
} from './wallet.money';

const walletAccountTypes = [
  'SPENDING',
  'EARNINGS',
  'FUNDING_RESERVED',
  'RESERVED_FOR_PAYOUTS',
] as const;

const initialPolicy = {
  revision: 1,
  minimumTopUpSatang: 100,
  maximumTopUpSatang: MAX_OPERATION_SATANG,
  minimumFundingReservationSatang: 100,
  maximumFundingReservationSatang: MAX_OPERATION_SATANG,
  minimumEarningsConversionSatang: 100,
  maximumEarningsConversionSatang: MAX_OPERATION_SATANG,
  minimumPayoutSatang: 100,
  maximumPayoutSatang: MAX_OPERATION_SATANG,
  platformFeeBps: 200,
  feeRoundingMode: 'UP',
  topUpProviderFeeSatang: 0,
  topUpProviderTaxBps: 0,
  payoutProviderFeeSatang: 0,
  payoutProviderTaxBps: 0,
  quoteLifetimeSeconds: 300,
  reason: 'Initial Wallet & Payments policy',
  effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
};

export type WalletTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const accountCode = (walletId: string, type: string): string => `wallet:${walletId}:${type}`;
const platformAccountCode = (type: 'PLATFORM_REVENUE' | 'PLATFORM_SUSPENSE'): string => `platform:${type}`;

const validateWalletAmounts = <T extends {
  spendingBalanceSatang: number;
  earningsBalanceSatang: number;
  fundingReservedSatang: number;
  reservedForPayoutsSatang: number;
}>(wallet: T) => ({
  ...wallet,
  spendingBalanceSatang: satang(wallet.spendingBalanceSatang),
  earningsBalanceSatang: satang(wallet.earningsBalanceSatang),
  fundingReservedSatang: satang(wallet.fundingReservedSatang),
  reservedForPayoutsSatang: satang(wallet.reservedForPayoutsSatang),
});

const validatePolicyAmounts = <T extends {
  minimumTopUpSatang: number;
  maximumTopUpSatang: number;
  minimumFundingReservationSatang: number;
  maximumFundingReservationSatang: number;
  minimumEarningsConversionSatang: number;
  maximumEarningsConversionSatang: number;
  minimumPayoutSatang: number;
  maximumPayoutSatang: number;
  topUpProviderFeeSatang: number;
  payoutProviderFeeSatang: number;
}>(policy: T) => ({
  ...policy,
  minimumTopUpSatang: satang(policy.minimumTopUpSatang),
  maximumTopUpSatang: satang(policy.maximumTopUpSatang),
  minimumFundingReservationSatang: satang(policy.minimumFundingReservationSatang),
  maximumFundingReservationSatang: satang(policy.maximumFundingReservationSatang),
  minimumEarningsConversionSatang: satang(policy.minimumEarningsConversionSatang),
  maximumEarningsConversionSatang: satang(policy.maximumEarningsConversionSatang),
  minimumPayoutSatang: satang(policy.minimumPayoutSatang),
  maximumPayoutSatang: satang(policy.maximumPayoutSatang),
  topUpProviderFeeSatang: satang(policy.topUpProviderFeeSatang),
  payoutProviderFeeSatang: satang(policy.payoutProviderFeeSatang),
});

const validateActivityAmounts = <T extends {
  spendingDeltaSatang: number;
  earningsDeltaSatang: number;
  fundingReservedDeltaSatang: number;
  payoutReservedDeltaSatang: number;
}>(activity: T) => ({
  ...activity,
  spendingDeltaSatang: satangDelta(activity.spendingDeltaSatang),
  earningsDeltaSatang: satangDelta(activity.earningsDeltaSatang),
  fundingReservedDeltaSatang: satangDelta(activity.fundingReservedDeltaSatang),
  payoutReservedDeltaSatang: satangDelta(activity.payoutReservedDeltaSatang),
});

export const ensureWalletInTransaction = async (transaction: WalletTransaction, userId: string) => {
  const [student] = await transaction
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.id, userId))
    .limit(1);

  if (!student) throw new MoneyDomainError('STUDENT_NOT_FOUND', 'Student does not exist.');

  await transaction.insert(walletWallet).values({ userId }).onConflictDoNothing({ target: walletWallet.userId });

  const [wallet] = await transaction
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId))
    .limit(1);

  if (!wallet) throw new MoneyDomainError('WALLET_PROVISION_FAILED', 'Wallet could not be provisioned.');

  await transaction
    .insert(walletLedgerAccount)
    .values(walletAccountTypes.map((type) => ({
      code: accountCode(wallet.id, type),
      type,
      walletId: wallet.id,
    })))
    .onConflictDoNothing({ target: walletLedgerAccount.code });

  await transaction
    .insert(walletStatusHistory)
    .values({ walletId: wallet.id, toStatus: 'ACTIVE', reason: 'Wallet provisioned' })
    .onConflictDoNothing();

  await transaction
    .insert(walletLedgerAccount)
    .values([
      { code: platformAccountCode('PLATFORM_REVENUE'), type: 'PLATFORM_REVENUE' },
      { code: platformAccountCode('PLATFORM_SUSPENSE'), type: 'PLATFORM_SUSPENSE' },
    ])
    .onConflictDoNothing({ target: walletLedgerAccount.code });

  return wallet;
};

export const ensureWallet = async (userId: string) =>
  validateWalletAmounts(await db.transaction(
    (transaction) => ensureWalletInTransaction(transaction, userId),
  ));

export const getWallet = async (userId: string) => {
  const [wallet] = await db
    .select()
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId))
    .limit(1);

  if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  return validateWalletAmounts(wallet);
};

export const getWalletActivities = async (userId: string, limit = 50) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new MoneyDomainError('INVALID_LIMIT', 'Activity limit must be between 1 and 100.');
  }

  const activities = await db
    .select()
    .from(walletActivity)
    .where(eq(walletActivity.userId, userId))
    .orderBy(desc(walletActivity.occurredAt))
    .limit(limit);
  return activities.map(validateActivityAmounts);
};

export const ensureInitialMoneyPolicy = async () => {
  const [existing] = await db
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(eq(paymentMoneyPolicyRevision.revision, initialPolicy.revision))
    .limit(1);

  if (existing) return validatePolicyAmounts(existing);

  const [created] = await db
    .insert(paymentMoneyPolicyRevision)
    .values(initialPolicy)
    .onConflictDoNothing({ target: paymentMoneyPolicyRevision.revision })
    .returning();

  if (created) return validatePolicyAmounts(created);

  const [raceWinner] = await db
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(eq(paymentMoneyPolicyRevision.revision, initialPolicy.revision))
    .limit(1);

  if (!raceWinner) throw new MoneyDomainError('POLICY_NOT_AVAILABLE', 'Money Policy could not be initialized.');
  return validatePolicyAmounts(raceWinner);
};

export const getEffectiveMoneyPolicy = async (at = new Date()) => {
  const policies = await db
    .select()
    .from(paymentMoneyPolicyRevision)
    .where(
      and(
        lte(paymentMoneyPolicyRevision.effectiveFrom, at),
        or(isNull(paymentMoneyPolicyRevision.effectiveUntil), gt(paymentMoneyPolicyRevision.effectiveUntil, at)),
      ),
    )
    .orderBy(desc(paymentMoneyPolicyRevision.revision))
    .limit(2);

  if (policies.length > 1) {
    throw new MoneyDomainError('POLICY_OVERLAP', 'More than one Money Policy is effective.');
  }
  if (!policies[0]) {
    throw new MoneyDomainError('POLICY_NOT_AVAILABLE', 'No Money Policy is effective at this time.');
  }
  return validatePolicyAmounts(policies[0]);
};

const deriveWalletProjectionInTransaction = async (
  transaction: WalletTransaction,
  walletId: string,
  lockWallet: boolean,
) => {
  const [wallet] = lockWallet
    ? await transaction.select().from(walletWallet).where(eq(walletWallet.id, walletId)).for('update')
    : await transaction.select().from(walletWallet).where(eq(walletWallet.id, walletId));
  if (!wallet) throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');

  const accounts = await transaction
    .select({ id: walletLedgerAccount.id, type: walletLedgerAccount.type })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, walletId), inArray(walletLedgerAccount.type, walletAccountTypes)));
  const accountIds = accounts.map(({ id }) => id);
  const postings = accountIds.length === 0
    ? []
    : await transaction
      .select({
        accountId: walletLedgerPosting.accountId,
        amount: walletLedgerPosting.amountSatang,
        transactionId: walletLedgerTransaction.id,
        eventType: walletLedgerTransaction.eventType,
        occurredAt: walletLedgerTransaction.createdAt,
      })
      .from(walletLedgerPosting)
      .innerJoin(walletLedgerTransaction, eq(walletLedgerPosting.transactionId, walletLedgerTransaction.id))
      .where(and(inArray(walletLedgerPosting.accountId, accountIds), sql`${walletLedgerTransaction.sealedAt} IS NOT NULL`));

  const totals = new Map<string, number>(walletAccountTypes.map((type) => [type, 0]));
  for (const posting of postings) totals.set(posting.accountId, (totals.get(posting.accountId) ?? 0) + posting.amount);

  const balances = new Map<string, number>();
  for (const account of accounts) balances.set(account.type, totals.get(account.id) ?? 0);
  const projectedBalances = {
    spendingBalanceSatang: balances.get('SPENDING') ?? 0,
    earningsBalanceSatang: balances.get('EARNINGS') ?? 0,
    fundingReservedSatang: balances.get('FUNDING_RESERVED') ?? 0,
    reservedForPayoutsSatang: balances.get('RESERVED_FOR_PAYOUTS') ?? 0,
  };
  const total = Object.values(projectedBalances).reduce((sum, value) => sum + value, 0);
  if (total < 0 || total > MAX_WALLET_CAPACITY_SATANG || Object.values(projectedBalances).some((value) => value < 0)) {
    throw new MoneyDomainError('INVALID_LEDGER_BALANCE', 'Ledger projection violates Wallet balance invariants.');
  }

  const transactionDeltas = new Map<string, {
    eventType: LedgerEventType;
    occurredAt: Date;
    spending: number;
    earnings: number;
    fundingReserved: number;
    payoutReserved: number;
  }>();
  for (const posting of postings) {
    const account = accounts.find(({ id }) => id === posting.accountId);
    if (!account) continue;
    const delta = transactionDeltas.get(posting.transactionId) ?? {
      eventType: posting.eventType,
      occurredAt: posting.occurredAt,
      spending: 0,
      earnings: 0,
      fundingReserved: 0,
      payoutReserved: 0,
    };
    if (account.type === 'SPENDING') delta.spending += posting.amount;
    if (account.type === 'EARNINGS') delta.earnings += posting.amount;
    if (account.type === 'FUNDING_RESERVED') delta.fundingReserved += posting.amount;
    if (account.type === 'RESERVED_FOR_PAYOUTS') delta.payoutReserved += posting.amount;
    transactionDeltas.set(posting.transactionId, delta);
  }

  const activities = [...transactionDeltas].map(([ledgerTransactionId, delta]) => ({
    ledgerTransactionId,
    userId: wallet.userId,
    type: activityTypeFor(delta.eventType, delta),
    activityStatus: 'COMPLETED' as const,
    spendingDeltaSatang: delta.spending,
    earningsDeltaSatang: delta.earnings,
    fundingReservedDeltaSatang: delta.fundingReserved,
    payoutReservedDeltaSatang: delta.payoutReserved,
    resourceType: 'wallet_ledger_transaction',
    resourceId: ledgerTransactionId,
    occurredAt: delta.occurredAt,
  }));
  return { activities, projectedBalances, wallet };
};

const activityTypeFor = (eventType: LedgerEventType, deltas: {
  spending: number;
  earnings: number;
}) => {
  if (eventType === 'TOP_UP') return 'TOP_UP' as const;
  if (eventType === 'FUNDING_RESERVE') return 'HOLD' as const;
  if (eventType === 'FUNDING_RELEASE') return 'RELEASE' as const;
  if (eventType === 'PAYOUT') return 'SPEND' as const;
  return deltas.earnings > 0 ? 'EARN' as const : 'SPEND' as const;
};

const rebuildWalletProjectionInTransaction = async (
  transaction: WalletTransaction,
  walletId: string,
) => {
  const projection = await deriveWalletProjectionInTransaction(transaction, walletId, true);
  const [updated] = await transaction
    .update(walletWallet)
    .set(projection.projectedBalances)
    .where(eq(walletWallet.id, walletId))
    .returning();
  await transaction.delete(walletActivity).where(eq(walletActivity.userId, projection.wallet.userId));
  if (projection.activities.length > 0) {
    await transaction.insert(walletActivity).values(projection.activities);
  }
  return { activities: projection.activities, wallet: updated };
};

export const rebuildWalletProjection = async (walletId: string) => {
  const rebuilt = await db.transaction(
    (transaction) => rebuildWalletProjectionInTransaction(transaction, walletId),
  );
  return {
    activities: rebuilt.activities.map(validateActivityAmounts),
    wallet: validateWalletAmounts(rebuilt.wallet),
  };
};

export type LedgerPostingInput = {
  accountId: string;
  amountSatang: SignedSatang;
};

export type SealedLedgerTransactionInput = {
  businessReference: string;
  eventType: LedgerEventType;
  postings: LedgerPostingInput[];
  idempotencyKeyId?: string;
  createdByUserId?: string;
  description?: string;
  idempotency?: {
    principalUserId: string;
    operationScope: string;
    key: string;
    requestHash: string;
    expiresAt: Date;
  };
};

export const createSealedLedgerTransaction = async (input: SealedLedgerTransactionInput) => {
  if (
    input.postings.length < 2 ||
    input.postings.some(({ amountSatang }) =>
      !Number.isSafeInteger(amountSatang) ||
      amountSatang === 0 ||
      Math.abs(amountSatang) > MAX_WALLET_CAPACITY_SATANG,
    )
  ) {
    throw new MoneyDomainError('INVALID_LEDGER_POSTINGS', 'A ledger transaction needs non-zero integer postings.');
  }
  if (input.postings.reduce((total, posting) => total + posting.amountSatang, 0) !== 0) {
    throw new MoneyDomainError('UNBALANCED_LEDGER', 'Ledger postings must balance to zero.');
  }

  return db.transaction(async (transaction) => {
    let idempotencyKeyId = input.idempotencyKeyId;
    if (input.idempotency) {
      const [existingOrCreated] = await transaction
        .insert(walletIdempotencyKey)
        .values(input.idempotency)
        .onConflictDoNothing()
        .returning();
      const [keyRecord] = existingOrCreated
        ? [existingOrCreated]
        : await transaction
          .select()
          .from(walletIdempotencyKey)
          .where(and(
            eq(walletIdempotencyKey.principalUserId, input.idempotency.principalUserId),
            eq(walletIdempotencyKey.operationScope, input.idempotency.operationScope),
            eq(walletIdempotencyKey.key, input.idempotency.key),
          ))
          .for('update');
      if (!keyRecord) throw new MoneyDomainError('IDEMPOTENCY_UNAVAILABLE', 'Idempotency key could not be acquired.');
      if (keyRecord.requestHash !== input.idempotency.requestHash) {
        throw new MoneyDomainError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used with a different request.');
      }
      idempotencyKeyId = keyRecord.id;
      if (keyRecord.resourceId) {
        const [replayed] = await transaction
          .select()
          .from(walletLedgerTransaction)
          .where(eq(walletLedgerTransaction.id, keyRecord.resourceId));
        if (replayed) return replayed;
      }
      if (!existingOrCreated) {
        throw new MoneyDomainError('IDEMPOTENCY_IN_PROGRESS', 'An operation with this idempotency key is still processing.');
      }
    }
    const [created] = await transaction
      .insert(walletLedgerTransaction)
      .values({
        businessReference: input.businessReference,
        eventType: input.eventType,
        idempotencyKeyId,
        createdByUserId: input.createdByUserId,
        description: input.description,
      })
      .returning();

    if (!created) throw new MoneyDomainError('LEDGER_CREATE_FAILED', 'Ledger transaction could not be created.');

    if (input.idempotency) {
      await transaction
        .update(walletIdempotencyKey)
        .set({ resourceType: 'wallet_ledger_transaction', resourceId: created.id })
        .where(eq(walletIdempotencyKey.id, idempotencyKeyId!));
    }

    await transaction.insert(walletLedgerPosting).values(
      input.postings.map((posting) => ({ ...posting, transactionId: created.id })),
    );
    const [sealed] = await transaction
      .update(walletLedgerTransaction)
      .set({ sealedAt: new Date() })
      .where(eq(walletLedgerTransaction.id, created.id))
      .returning();

    if (input.idempotency) {
      await transaction
        .update(walletIdempotencyKey)
        .set({ processingStatus: 'COMPLETED', completedAt: new Date() })
        .where(eq(walletIdempotencyKey.id, idempotencyKeyId!));
    }

    const accountIds = [...new Set(input.postings.map(({ accountId }) => accountId))];
    const walletRows = await transaction
      .select({ walletId: walletLedgerAccount.walletId })
      .from(walletLedgerAccount)
      .where(and(inArray(walletLedgerAccount.id, accountIds), sql`${walletLedgerAccount.walletId} IS NOT NULL`));
    const walletIds = [...new Set(
      walletRows.flatMap(({ walletId }) => walletId ? [walletId] : []),
    )].sort();
    for (const walletId of walletIds) {
      // Lock Wallets in stable order to avoid cross-Wallet transaction deadlocks.
      // eslint-disable-next-line no-await-in-loop
      await rebuildWalletProjectionInTransaction(transaction, walletId);
    }

    return sealed;
  });
};

export const verifyWalletProjection = async (walletId: string) => {
  return db.transaction(async (transaction) => {
    const projection = await deriveWalletProjectionInTransaction(transaction, walletId, false);
    const storedActivities = await transaction
      .select()
      .from(walletActivity)
      .where(eq(walletActivity.userId, projection.wallet.userId));
    const expectedActivities = projection.activities.map(({ userId: _userId, ...activity }) => activity);
    const actualActivities = storedActivities.map(({
      id: _id,
      userId: _userId,
      ...activity
    }) => activity);
    const byTransactionId = (left: { ledgerTransactionId: string }, right: { ledgerTransactionId: string }) =>
      left.ledgerTransactionId.localeCompare(right.ledgerTransactionId);
    actualActivities.sort(byTransactionId);
    expectedActivities.sort(byTransactionId);
    return {
      matches: projection.wallet.spendingBalanceSatang === projection.projectedBalances.spendingBalanceSatang &&
        projection.wallet.earningsBalanceSatang === projection.projectedBalances.earningsBalanceSatang &&
        projection.wallet.fundingReservedSatang === projection.projectedBalances.fundingReservedSatang &&
        projection.wallet.reservedForPayoutsSatang === projection.projectedBalances.reservedForPayoutsSatang &&
        JSON.stringify(actualActivities) === JSON.stringify(expectedActivities),
      expected: {
        activities: projection.activities.map(validateActivityAmounts),
        wallet: validateWalletAmounts({
          ...projection.wallet,
          ...projection.projectedBalances,
        }),
      },
      wallet: validateWalletAmounts(projection.wallet),
    };
  });
};

export const listWalletStatusHistory = async (walletId: string) =>
  db.select().from(walletStatusHistory).where(eq(walletStatusHistory.walletId, walletId)).orderBy(asc(walletStatusHistory.occurredAt));

export const validateOperationAmount = (amount: number, minimum: number, maximum: number): Satang => {
  const value = positiveSatang(amount);
  if (value < minimum || value > maximum) {
    throw new MoneyDomainError('AMOUNT_OUT_OF_RANGE', 'Amount is outside the active Money Policy limits.');
  }
  return value;
};
