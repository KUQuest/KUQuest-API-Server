import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentMoneyPolicyRevision,
  walletFundingReservation,
  walletFundingReservationOperation,
  walletFundingReservationSettlement,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  increaseFundingReservation,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
  satang,
  signedSatang,
  settleFundingReservation,
  verifyWalletProjection,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const ownerUserId = `be111-owner-${crypto.randomUUID()}`;
const recipientUserId = `be111-recipient-${crypto.randomUUID()}`;
const amount = (value: number) => positiveSatang(value);
const fee = (value: number) => satang(value);

const withCurrentDate = async <T>(at: Date, callback: () => Promise<T>) => {
  const RealDate = globalThis.Date;
  const fixedTime = at.getTime();
  const FrozenDate = class extends RealDate {
    constructor(value?: string | number | Date) {
      super(value === undefined ? fixedTime : value instanceof RealDate ? value.getTime() : value);
    }

    static now() {
      return fixedTime;
    }
  };
  globalThis.Date = FrozenDate as DateConstructor;
  try {
    return await callback();
  } finally {
    globalThis.Date = RealDate;
  }
};

const accountId = async (userId: string, type: 'SPENDING' | 'EARNINGS' | 'FUNDING_RESERVED') => {
  const [wallet] = await db
    .select({ id: walletWallet.id })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));
  const [account] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, type)));
  return account.id;
};

const createFundedStudent = async (prefix: string, amountSatang = 10_000) => {
  const userId = `${prefix}-${crypto.randomUUID()}`;
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'Funding',
    lastName: 'Test',
  });
  await ensureWallet(userId);
  const spendingAccountId = await accountId(userId, 'SPENDING');
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  await createSealedLedgerTransaction({
    businessReference: `${prefix}-funding-${crypto.randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spendingAccountId, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
  return userId;
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  await db.insert(authUser).values({
    id: ownerUserId,
    email: `${ownerUserId}@ku.th`,
    firstName: 'Funding',
    lastName: 'Owner',
  });
  await db.insert(authUser).values({
    id: recipientUserId,
    email: `${recipientUserId}@ku.th`,
    firstName: 'Funding',
    lastName: 'Recipient',
  });
  await ensureWallet(ownerUserId);
  await ensureWallet(recipientUserId);

  const spendingAccountId = await accountId(ownerUserId, 'SPENDING');
  const [suspense] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  await createSealedLedgerTransaction({
    businessReference: `be111-funding-${crypto.randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spendingAccountId, amountSatang: signedSatang(10_000) },
      { accountId: suspense.id, amountSatang: signedSatang(-10_000) },
    ],
  });
});

describe('Funding Reservation service', () => {
  it('reserves Spending atomically through the caller transaction', async () => {
    const callerReference = `workflow-${crypto.randomUUID()}`;

    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId,
      callerScope: 'generic-workflow',
      callerReference,
      amountSatang: amount(4_000),
    }));

    expect(reservation).toMatchObject({
      ownerUserId,
      callerScope: 'generic-workflow',
      callerReference,
      totalReservedSatang: 4_000,
      remainingSatang: 4_000,
      status: 'ACTIVE',
    });
    const [policy] = await db
      .select({ id: paymentMoneyPolicyRevision.id })
      .from(paymentMoneyPolicyRevision)
      .where(eq(paymentMoneyPolicyRevision.revision, 1));
    expect(reservation.policyRevisionId).toBe(policy.id);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, ownerUserId))).toMatchObject([
      { spendingBalanceSatang: 6_000, fundingReservedSatang: 4_000 },
    ]);

    const [stored] = await db
      .select()
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.id, reservation.id));
    const [ledgerTransaction] = await db
      .select()
      .from(walletLedgerTransaction)
      .where(eq(walletLedgerTransaction.id, stored.createdLedgerTransactionId));
    const postings = await db
      .select({ amountSatang: walletLedgerPosting.amountSatang })
      .from(walletLedgerPosting)
      .where(eq(walletLedgerPosting.transactionId, ledgerTransaction.id));

    expect(ledgerTransaction.sealedAt).toBeInstanceOf(Date);
    expect(postings.map(({ amountSatang }) => amountSatang).sort((a, b) => a - b)).toEqual([-4_000, 4_000]);
  });

  it('replays reserve, increase, and release operation results', async () => {
    const payerUserId = await createFundedStudent('be111-operation-replay', 2_000);
    const reserveInput = {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `operation-replay-${crypto.randomUUID()}`,
      amountSatang: amount(1_000),
    };
    const reserved = await db.transaction((transaction) => reserveSpending(transaction, reserveInput));
    const reserveReplay = await db.transaction((transaction) => reserveSpending(transaction, reserveInput));
    expect(reserveReplay).toEqual(reserved);

    const increaseInput = {
      ownerUserId: payerUserId,
      reservationId: reserved.id,
      operationReference: `increase-replay-${crypto.randomUUID()}`,
      amountSatang: amount(400),
    };
    const increased = await db.transaction((transaction) => increaseFundingReservation(transaction, increaseInput));
    const increaseReplay = await db.transaction((transaction) => increaseFundingReservation(transaction, increaseInput));
    expect(increaseReplay).toEqual(increased);

    const releaseInput = {
      ownerUserId: payerUserId,
      reservationId: reserved.id,
      operationReference: `release-replay-${crypto.randomUUID()}`,
    };
    const released = await db.transaction((transaction) => releaseFundingReservation(transaction, releaseInput));
    const releaseReplay = await db.transaction((transaction) => releaseFundingReservation(transaction, releaseInput));
    expect(releaseReplay).toEqual(released);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payerUserId)))
      .toMatchObject([{ spendingBalanceSatang: 2_000, fundingReservedSatang: 0 }]);

    await expect(db.transaction((transaction) => reserveSpending(transaction, {
      ...reserveInput,
      amountSatang: amount(1_001),
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('increases an active reservation with additional Spending', async () => {
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId,
      callerScope: 'generic-workflow',
      callerReference: `increase-${crypto.randomUUID()}`,
      amountSatang: amount(1_000),
    }));

    const increased = await db.transaction((transaction) => increaseFundingReservation(transaction, {
      ownerUserId,
      reservationId: reservation.id,
      operationReference: `increase-operation-${crypto.randomUUID()}`,
      amountSatang: amount(500),
    }));

    expect(increased).toMatchObject({ totalReservedSatang: 1_500, remainingSatang: 1_500 });
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, ownerUserId))).toMatchObject([
      { spendingBalanceSatang: 4_500, fundingReservedSatang: 5_500 },
    ]);
  });

  it('releases all remaining funds even while the Wallet is frozen', async () => {
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId,
      callerScope: 'generic-workflow',
      callerReference: `release-${crypto.randomUUID()}`,
      amountSatang: amount(1_000),
    }));
    await db
      .update(walletWallet)
      .set({ walletStatus: 'FROZEN' })
      .where(eq(walletWallet.userId, ownerUserId));

    const released = await db.transaction((transaction) => releaseFundingReservation(transaction, {
      ownerUserId,
      reservationId: reservation.id,
      operationReference: `release-operation-${crypto.randomUUID()}`,
    }));

    expect(released).toMatchObject({ status: 'RELEASED', remainingSatang: 0 });
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, ownerUserId))).toMatchObject([
      { spendingBalanceSatang: 4_500, fundingReservedSatang: 5_500, walletStatus: 'FROZEN' },
    ]);
    await db
      .update(walletWallet)
      .set({ walletStatus: 'ACTIVE' })
      .where(eq(walletWallet.userId, ownerUserId));
  });

  it('partially settles to recipient Earnings plus a Platform Fee', async () => {
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId,
      callerScope: 'generic-workflow',
      callerReference: `settle-${crypto.randomUUID()}`,
      amountSatang: amount(2_000),
    }));

    const settlement = await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId,
      reservationId: reservation.id,
      settlementReference: `partial-${crypto.randomUUID()}`,
      recipientUserId,
      recipientAmountSatang: amount(1_000),
      platformFeeSatang: fee(20),
    }));

    expect(settlement).toMatchObject({
      reservationId: reservation.id,
      recipientUserId,
      recipientAmountSatang: amount(1_000),
      platformFeeSatang: fee(20),
      totalAmountSatang: 1_020,
    });
    expect(await db.select().from(walletFundingReservation).where(eq(walletFundingReservation.id, reservation.id)))
      .toMatchObject([{ remainingSatang: 980, status: 'ACTIVE' }]);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, recipientUserId)))
      .toMatchObject([{ earningsBalanceSatang: 1_000 }]);
    expect(await db.select().from(walletFundingReservationSettlement).where(
      eq(walletFundingReservationSettlement.id, settlement.id),
    )).toHaveLength(1);
  });

  it('continues using the reservation policy snapshot after a newer policy becomes effective', async () => {
    const payerUserId = await createFundedStudent('be111-policy-snapshot-payer', 1_000);
    const payeeUserId = await createFundedStudent('be111-policy-snapshot-payee', 100);
    const activePolicy = await ensureInitialMoneyPolicy();
    const revision = Math.floor(Math.random() * 1_000_000) + 1_000_000;
    const existingPolicies = await db
      .select({ effectiveFrom: paymentMoneyPolicyRevision.effectiveFrom, effectiveUntil: paymentMoneyPolicyRevision.effectiveUntil })
      .from(paymentMoneyPolicyRevision);
    let windowStart = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidateStart = Date.UTC(2020, 0, 1) + Math.floor(Math.random() * (Date.UTC(2024, 0, 1) - Date.UTC(2020, 0, 1) - 3_600_000));
      const candidateEnd = candidateStart + 7_200_000;
      const overlaps = existingPolicies.some((policy) =>
        policy.effectiveFrom.getTime() < candidateEnd &&
        (policy.effectiveUntil === null || policy.effectiveUntil.getTime() > candidateStart),
      );
      if (!overlaps) {
        windowStart = candidateStart;
        break;
      }
    }
    if (windowStart === 0) throw new Error('Could not find an unused Money Policy test window.');
    const newerPolicyAt = new Date(windowStart + 3_600_000);
    const olderPolicy = {
      ...activePolicy,
      id: crypto.randomUUID(),
      revision,
      minimumFundingReservationSatang: 100,
      maximumFundingReservationSatang: 500,
      platformFeeBps: 1_000,
      effectiveFrom: new Date(windowStart),
      effectiveUntil: newerPolicyAt,
      reason: 'BE-111 policy snapshot source',
    };
    const newerPolicy = {
      ...activePolicy,
      id: crypto.randomUUID(),
      revision: revision + 1,
      minimumFundingReservationSatang: 100,
      maximumFundingReservationSatang: 100,
      platformFeeBps: 5_000,
      effectiveFrom: newerPolicyAt,
      effectiveUntil: new Date(windowStart + 7_200_000),
      reason: 'BE-111 policy snapshot replacement',
    };
    await db.insert(paymentMoneyPolicyRevision).values([olderPolicy, newerPolicy]);

    const reservation = await withCurrentDate(
      new Date(windowStart + 1_800_000),
      () => db.transaction((transaction) => reserveSpending(transaction, {
        ownerUserId: payerUserId,
        callerScope: 'generic-workflow',
        callerReference: `policy-snapshot-${crypto.randomUUID()}`,
        amountSatang: amount(400),
      })),
    );
    expect(reservation.policyRevisionId).toBe(olderPolicy.id);

    await withCurrentDate(
      new Date(windowStart + 5_400_000),
      () => db.transaction((transaction) => increaseFundingReservation(transaction, {
        ownerUserId: payerUserId,
        reservationId: reservation.id,
        operationReference: `policy-increase-${crypto.randomUUID()}`,
        amountSatang: amount(200),
      })),
    );
    const settlement = await withCurrentDate(
      new Date(windowStart + 5_400_000),
      () => db.transaction((transaction) => settleFundingReservation(transaction, {
        ownerUserId: payerUserId,
        reservationId: reservation.id,
        settlementReference: `policy-settlement-${crypto.randomUUID()}`,
        recipientUserId: payeeUserId,
        recipientAmountSatang: amount(100),
        platformFeeSatang: fee(10),
      })),
    );

    expect(settlement.platformFeeSatang).toBe(10);
  });

  it('releases exactly the remaining funds after a partial settlement', async () => {
    const payerUserId = await createFundedStudent('be111-release-remainder-payer', 1_000);
    const payeeUserId = await createFundedStudent('be111-release-remainder-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `release-remainder-${crypto.randomUUID()}`,
      amountSatang: amount(400),
    }));
    await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `release-remainder-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: amount(150),
    }));

    const released = await db.transaction((transaction) => releaseFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      operationReference: `release-remainder-operation-${crypto.randomUUID()}`,
    }));
    expect(released).toMatchObject({ remainingSatang: 0, status: 'RELEASED' });
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payerUserId)))
      .toMatchObject([{ spendingBalanceSatang: 850, fundingReservedSatang: 0 }]);

    const [releaseOperation] = await db
      .select()
      .from(walletFundingReservationOperation)
      .where(and(
        eq(walletFundingReservationOperation.reservationId, reservation.id),
        eq(walletFundingReservationOperation.operationType, 'RELEASE'),
      ));
    expect(releaseOperation.amountSatang).toBe(250);
    expect(await db
      .select({ amountSatang: walletLedgerPosting.amountSatang })
      .from(walletLedgerPosting)
      .where(eq(walletLedgerPosting.transactionId, releaseOperation.ledgerTransactionId)))
      .toMatchObject([{ amountSatang: -250 }, { amountSatang: 250 }]);
  });

  it('replays the same settlement and rejects conflicting key reuse', async () => {
    const payerUserId = await createFundedStudent('be111-retry-payer');
    const payeeUserId = await createFundedStudent('be111-retry-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `retry-${crypto.randomUUID()}`,
      amountSatang: amount(1_000),
    }));
    const settlementReference = `settlement-${crypto.randomUUID()}`;
    const input = {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference,
      recipientUserId: payeeUserId,
      recipientAmountSatang: amount(600),
      platformFeeSatang: fee(12),
    };

    const first = await db.transaction((transaction) => settleFundingReservation(transaction, input));
    const replay = await db.transaction((transaction) => settleFundingReservation(transaction, input));

    expect(replay.id).toBe(first.id);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payeeUserId)))
      .toMatchObject([{ earningsBalanceSatang: 600 }]);
    await expect(db.transaction((transaction) => settleFundingReservation(transaction, {
      ...input,
      recipientAmountSatang: amount(601),
      platformFeeSatang: fee(13),
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('serializes concurrent settlements so they cannot oversettle', async () => {
    const payerUserId = await createFundedStudent('be111-concurrent-payer');
    const payeeUserId = await createFundedStudent('be111-concurrent-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `concurrent-${crypto.randomUUID()}`,
      amountSatang: amount(1_000),
    }));
    const settle = (settlementReference: string) => db.transaction((transaction) =>
      settleFundingReservation(transaction, {
        ownerUserId: payerUserId,
        reservationId: reservation.id,
        settlementReference,
        recipientUserId: payeeUserId,
        recipientAmountSatang: amount(700),
      }));

    const results = await Promise.allSettled([
      settle(`concurrent-a-${crypto.randomUUID()}`),
      settle(`concurrent-b-${crypto.randomUUID()}`),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await db.select().from(walletFundingReservation).where(eq(walletFundingReservation.id, reservation.id)))
      .toMatchObject([{ remainingSatang: 300, status: 'ACTIVE' }]);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payeeUserId)))
      .toMatchObject([{ earningsBalanceSatang: 700 }]);
  });

  it('rejects reservation overspend and non-active Wallet commitments without partial effects', async () => {
    const payerUserId = await createFundedStudent('be111-overspend-payer', 500);
    const callerReference = `overspend-${crypto.randomUUID()}`;

    await expect(db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference,
      amountSatang: amount(600),
    }))).rejects.toMatchObject({ code: 'INSUFFICIENT_SPENDING_BALANCE' });
    expect(await db.select().from(walletFundingReservation).where(
      eq(walletFundingReservation.callerReference, callerReference),
    )).toHaveLength(0);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payerUserId)))
      .toMatchObject([{ spendingBalanceSatang: 500, fundingReservedSatang: 0 }]);

    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `active-${crypto.randomUUID()}`,
      amountSatang: amount(400),
    }));
    await expect(db.transaction((transaction) => increaseFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      operationReference: `overspend-increase-${crypto.randomUUID()}`,
      amountSatang: amount(200),
    }))).rejects.toMatchObject({ code: 'INSUFFICIENT_SPENDING_BALANCE' });
    expect(await db.select().from(walletFundingReservation).where(eq(walletFundingReservation.id, reservation.id)))
      .toMatchObject([{ totalReservedSatang: 400, remainingSatang: 400 }]);
    await db.update(walletWallet).set({ walletStatus: 'SUSPENDED' }).where(eq(walletWallet.userId, payerUserId));
    await expect(db.transaction((transaction) => increaseFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      operationReference: `blocked-${crypto.randomUUID()}`,
      amountSatang: amount(100),
    }))).rejects.toMatchObject({ code: 'WALLET_NOT_ACTIVE' });
    expect(await db.select().from(walletFundingReservation).where(eq(walletFundingReservation.id, reservation.id)))
      .toMatchObject([{ totalReservedSatang: 400, remainingSatang: 400 }]);
  });

  it('keeps settlement funds reserved when recipient capacity would overflow', async () => {
    const payerUserId = await createFundedStudent('be111-capacity-payer', 1_000);
    const payeeUserId = await createFundedStudent('be111-capacity-payee', 1_999_999_950);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `capacity-${crypto.randomUUID()}`,
      amountSatang: amount(200),
    }));

    await expect(db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `capacity-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: amount(100),
    }))).rejects.toMatchObject({ code: 'WALLET_CAPACITY_EXCEEDED' });

    expect(await db.select().from(walletFundingReservation).where(eq(walletFundingReservation.id, reservation.id)))
      .toMatchObject([{ remainingSatang: 200, status: 'ACTIVE' }]);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payeeUserId)))
      .toMatchObject([{ spendingBalanceSatang: 1_999_999_950, earningsBalanceSatang: 0 }]);
  });

  it('rolls back reservation domain and money state with the caller transaction', async () => {
    const payerUserId = await createFundedStudent('be111-rollback-payer', 1_000);
    const callerReference = `rollback-${crypto.randomUUID()}`;

    await expect(db.transaction(async (transaction) => {
      await reserveSpending(transaction, {
        ownerUserId: payerUserId,
        callerScope: 'generic-workflow',
        callerReference,
        amountSatang: amount(400),
      });
      throw new Error('caller workflow failed');
    })).rejects.toThrow('caller workflow failed');

    expect(await db.select().from(walletFundingReservation).where(
      eq(walletFundingReservation.callerReference, callerReference),
    )).toHaveLength(0);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payerUserId)))
      .toMatchObject([{ spendingBalanceSatang: 1_000, fundingReservedSatang: 0 }]);
  });

  it('settles existing obligations when payer and recipient Wallets are non-active', async () => {
    const payerUserId = await createFundedStudent('be111-status-payer', 1_000);
    const payeeUserId = await createFundedStudent('be111-status-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `status-${crypto.randomUUID()}`,
      amountSatang: amount(200),
    }));
    await db.update(walletWallet).set({ walletStatus: 'FROZEN' }).where(eq(walletWallet.userId, payerUserId));
    await db.update(walletWallet).set({ walletStatus: 'CLOSED' }).where(eq(walletWallet.userId, payeeUserId));

    const settlement = await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `status-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: amount(100),
    }));

    expect(settlement.recipientAmountSatang).toBe(100);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payeeUserId)))
      .toMatchObject([{ earningsBalanceSatang: 100, walletStatus: 'CLOSED' }]);
  });

  it('settles to the same Wallet at full capacity without false overflow', async () => {
    const payerUserId = await createFundedStudent('be111-self-payer', 2_000_000_000);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `self-${crypto.randomUUID()}`,
      amountSatang: amount(200),
    }));

    await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `self-settlement-${crypto.randomUUID()}`,
      recipientUserId: payerUserId,
      recipientAmountSatang: amount(100),
    }));

    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payerUserId)))
      .toMatchObject([{
        spendingBalanceSatang: 1_999_999_800,
        earningsBalanceSatang: 100,
        fundingReservedSatang: 100,
      }]);
  });

  it('keeps payer and recipient activity projections equal to the sealed ledger', async () => {
    const payerUserId = await createFundedStudent('be111-projection-payer', 1_000);
    const payeeUserId = await createFundedStudent('be111-projection-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `projection-${crypto.randomUUID()}`,
      amountSatang: amount(400),
    }));
    await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `projection-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: amount(200),
      platformFeeSatang: fee(4),
    }));
    const [payerWallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, payerUserId));
    const [payeeWallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, payeeUserId));

    expect((await verifyWalletProjection(payerWallet.id)).matches).toBe(true);
    expect((await verifyWalletProjection(payeeWallet.id)).matches).toBe(true);
  });

  it('enforces Funding Reservation ownership and immutability in PostgreSQL', async () => {
    const payerUserId = await createFundedStudent('be111-invariant-payer', 1_000);
    const payeeUserId = await createFundedStudent('be111-invariant-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `invariant-${crypto.randomUUID()}`,
      amountSatang: amount(300),
    }));
    const settlement = await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `invariant-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: amount(100),
    }));
    const releasable = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `immutable-${crypto.randomUUID()}`,
      amountSatang: amount(100),
    }));
    const [operation] = await db
      .select()
      .from(walletFundingReservationOperation)
      .where(eq(walletFundingReservationOperation.reservationId, reservation.id));

    await expect(db
      .update(walletFundingReservation)
      .set({ remainingSatang: releasable.remainingSatang - 1 })
      .where(eq(walletFundingReservation.id, releasable.id))
      .execute()).rejects.toThrow();

    await expect(db
      .update(walletFundingReservation)
      .set({ ownerUserId: payeeUserId })
      .where(eq(walletFundingReservation.id, reservation.id))
      .execute()).rejects.toThrow();
    await expect(db
      .update(walletFundingReservationSettlement)
      .set({ settlementReference: 'rewritten-history' })
      .where(eq(walletFundingReservationSettlement.id, settlement.id))
      .execute()).rejects.toThrow();
    await expect(db
      .delete(walletFundingReservation)
      .where(eq(walletFundingReservation.id, releasable.id))
      .execute()).rejects.toThrow();
    await expect(db
      .delete(walletFundingReservationSettlement)
      .where(eq(walletFundingReservationSettlement.id, settlement.id))
      .execute()).rejects.toThrow();
    await expect(db
      .update(walletFundingReservationOperation)
      .set({ operationReference: 'rewritten-operation' })
      .where(eq(walletFundingReservationOperation.id, operation.id))
      .execute()).rejects.toThrow();
    await expect(db
      .delete(walletFundingReservationOperation)
      .where(eq(walletFundingReservationOperation.id, operation.id))
      .execute()).rejects.toThrow();
  });
});
