import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  walletFundingReservation,
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
  releaseFundingReservation,
  reserveSpending,
  signedSatang,
  settleFundingReservation,
  verifyWalletProjection,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const ownerUserId = `be111-owner-${crypto.randomUUID()}`;
const recipientUserId = `be111-recipient-${crypto.randomUUID()}`;

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
      amountSatang: 4_000,
    }));

    expect(reservation).toMatchObject({
      ownerUserId,
      callerScope: 'generic-workflow',
      callerReference,
      totalReservedSatang: 4_000,
      remainingSatang: 4_000,
      status: 'ACTIVE',
    });
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

  it('increases an active reservation with additional Spending', async () => {
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId,
      callerScope: 'generic-workflow',
      callerReference: `increase-${crypto.randomUUID()}`,
      amountSatang: 1_000,
    }));

    const increased = await db.transaction((transaction) => increaseFundingReservation(transaction, {
      ownerUserId,
      reservationId: reservation.id,
      operationReference: `increase-operation-${crypto.randomUUID()}`,
      amountSatang: 500,
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
      amountSatang: 1_000,
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
      amountSatang: 2_000,
    }));

    const settlement = await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId,
      reservationId: reservation.id,
      settlementReference: `partial-${crypto.randomUUID()}`,
      recipientUserId,
      recipientAmountSatang: 1_000,
      platformFeeSatang: 20,
    }));

    expect(settlement).toMatchObject({
      reservationId: reservation.id,
      recipientUserId,
      recipientAmountSatang: 1_000,
      platformFeeSatang: 20,
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

  it('replays the same settlement and rejects conflicting key reuse', async () => {
    const payerUserId = await createFundedStudent('be111-retry-payer');
    const payeeUserId = await createFundedStudent('be111-retry-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `retry-${crypto.randomUUID()}`,
      amountSatang: 1_000,
    }));
    const settlementReference = `settlement-${crypto.randomUUID()}`;
    const input = {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference,
      recipientUserId: payeeUserId,
      recipientAmountSatang: 600,
      platformFeeSatang: 12,
    };

    const first = await db.transaction((transaction) => settleFundingReservation(transaction, input));
    const replay = await db.transaction((transaction) => settleFundingReservation(transaction, input));

    expect(replay.id).toBe(first.id);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, payeeUserId)))
      .toMatchObject([{ earningsBalanceSatang: 600 }]);
    await expect(db.transaction((transaction) => settleFundingReservation(transaction, {
      ...input,
      recipientAmountSatang: 601,
      platformFeeSatang: 13,
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('serializes concurrent settlements so they cannot oversettle', async () => {
    const payerUserId = await createFundedStudent('be111-concurrent-payer');
    const payeeUserId = await createFundedStudent('be111-concurrent-payee', 100);
    const reservation = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `concurrent-${crypto.randomUUID()}`,
      amountSatang: 1_000,
    }));
    const settle = (settlementReference: string) => db.transaction((transaction) =>
      settleFundingReservation(transaction, {
        ownerUserId: payerUserId,
        reservationId: reservation.id,
        settlementReference,
        recipientUserId: payeeUserId,
        recipientAmountSatang: 700,
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
      amountSatang: 600,
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
      amountSatang: 400,
    }));
    await db.update(walletWallet).set({ walletStatus: 'SUSPENDED' }).where(eq(walletWallet.userId, payerUserId));
    await expect(db.transaction((transaction) => increaseFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      operationReference: `blocked-${crypto.randomUUID()}`,
      amountSatang: 100,
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
      amountSatang: 200,
    }));

    await expect(db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `capacity-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: 100,
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
        amountSatang: 400,
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
      amountSatang: 200,
    }));
    await db.update(walletWallet).set({ walletStatus: 'FROZEN' }).where(eq(walletWallet.userId, payerUserId));
    await db.update(walletWallet).set({ walletStatus: 'CLOSED' }).where(eq(walletWallet.userId, payeeUserId));

    const settlement = await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `status-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: 100,
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
      amountSatang: 200,
    }));

    await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `self-settlement-${crypto.randomUUID()}`,
      recipientUserId: payerUserId,
      recipientAmountSatang: 100,
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
      amountSatang: 400,
    }));
    await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `projection-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: 200,
      platformFeeSatang: 4,
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
      amountSatang: 300,
    }));
    const settlement = await db.transaction((transaction) => settleFundingReservation(transaction, {
      ownerUserId: payerUserId,
      reservationId: reservation.id,
      settlementReference: `invariant-settlement-${crypto.randomUUID()}`,
      recipientUserId: payeeUserId,
      recipientAmountSatang: 100,
    }));
    const releasable = await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: payerUserId,
      callerScope: 'generic-workflow',
      callerReference: `immutable-${crypto.randomUUID()}`,
      amountSatang: 100,
    }));

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
  });
});
