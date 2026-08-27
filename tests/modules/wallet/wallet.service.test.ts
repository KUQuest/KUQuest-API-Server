import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentMoneyPolicyRevision,
  walletActivity,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletStatusHistory,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  getEffectiveMoneyPolicy,
  getWallet,
  getWalletActivities,
  rebuildWalletProjection,
  signedSatang,
  type Satang,
  type SatangDelta,
  verifyWalletProjection,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const studentId = crypto.randomUUID();

const getWalletAccountId = async (
  userId: string,
  type: 'SPENDING' | 'EARNINGS' | 'FUNDING_RESERVED' | 'RESERVED_FOR_PAYOUTS',
) => {
  const [account] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .innerJoin(walletWallet, eq(walletLedgerAccount.walletId, walletWallet.id))
    .where(and(
      eq(walletWallet.userId, userId),
      eq(walletLedgerAccount.type, type),
    ));
  if (!account) throw new Error(`Missing ${type} test account`);
  return account.id;
};

const getPlatformAccountId = async (type: 'PLATFORM_REVENUE' | 'PLATFORM_SUSPENSE') => {
  const [account] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, `platform:${type}`));
  if (!account) throw new Error(`Missing ${type} test account`);
  return account.id;
};

beforeAll(async () => {
  await sql`select 1`;
  await db.insert(authUser).values({
    id: studentId,
    email: `${studentId}@ku.th`,
    firstName: 'Wallet',
    lastName: 'Test',
  });
});

describe('Wallet provisioning service', () => {
  it('concurrently provisions one Wallet with four Student accounts', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => ensureWallet(studentId)));
    expect(new Set(wallets.map(({ id }) => id)).size).toBe(1);

    const accounts = await db
      .select({ type: walletLedgerAccount.type })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.walletId, wallets[0].id));
    expect(accounts.map(({ type }) => type).sort()).toEqual([
      'EARNINGS',
      'FUNDING_RESERVED',
      'RESERVED_FOR_PAYOUTS',
      'SPENDING',
    ]);
    expect((await db.select().from(walletStatusHistory).where(eq(walletStatusHistory.walletId, wallets[0].id)))).toHaveLength(1);
  });

  it('reads all four compartments without provisioning a missing Wallet', async () => {
    const wallet = await getWallet(studentId);
    const spendingBalance: Satang = wallet.spendingBalanceSatang;
    expect(Number(spendingBalance)).toBe(0);
    expect(wallet).toMatchObject({
      spendingBalanceSatang: 0,
      earningsBalanceSatang: 0,
      fundingReservedSatang: 0,
      reservedForPayoutsSatang: 0,
    });

    const studentWithoutWallet = `be109-no-wallet-${crypto.randomUUID()}`;
    await db.insert(authUser).values({
      id: studentWithoutWallet,
      email: `${studentWithoutWallet}@ku.th`,
      firstName: 'No',
      lastName: 'Wallet',
    });

    await expect(getWallet(studentWithoutWallet)).rejects.toMatchObject({
      code: 'WALLET_NOT_FOUND',
    });
  });

  it('initializes and reads the versioned Money Policy in satang', async () => {
    const created = await ensureInitialMoneyPolicy();
    const effective = await getEffectiveMoneyPolicy();

    expect(created.revision).toBe(1);
    expect(Number(effective.minimumTopUpSatang)).toBe(100);
    expect(Number(effective.maximumTopUpSatang)).toBe(70_000_000);
    expect(effective.platformFeeBps).toBe(200);
    expect(effective.quoteLifetimeSeconds).toBe(300);
    const minimumTopUp: Satang = effective.minimumTopUpSatang;
    expect(Number(minimumTopUp)).toBe(100);
  });

  it('seals a balanced transaction and writes an atomic activity projection', async () => {
    const spendingAccountId = await getWalletAccountId(studentId, 'SPENDING');
    const suspenseAccountId = await getPlatformAccountId('PLATFORM_SUSPENSE');

    const transaction = await createSealedLedgerTransaction({
      businessReference: `be109-top-up-${crypto.randomUUID()}`,
      eventType: 'TOP_UP',
      postings: [
        { accountId: spendingAccountId, amountSatang: signedSatang(125) },
        { accountId: suspenseAccountId, amountSatang: signedSatang(-125) },
      ],
    });

    expect(transaction?.sealedAt).toBeInstanceOf(Date);
    const [wallet] = await db
      .select({ id: walletWallet.id })
      .from(walletWallet)
      .where(eq(walletWallet.userId, studentId));
    await Bun.sleep(10);
    await rebuildWalletProjection(wallet.id);
    const activities = await db
      .select()
      .from(walletActivity)
      .where(eq(walletActivity.ledgerTransactionId, transaction!.id));
    expect(activities).toMatchObject([
      { activityStatus: 'COMPLETED', spendingDeltaSatang: 125, earningsDeltaSatang: 0 },
    ]);
    expect(activities[0].occurredAt).toEqual(transaction!.createdAt);
    const listedActivities = await getWalletActivities(studentId);
    const spendingDelta: SatangDelta = listedActivities[0].spendingDeltaSatang;
    expect(Number(spendingDelta)).toBe(125);
    expect(await db.select().from(walletWallet).where(eq(walletWallet.userId, studentId))).toMatchObject([
      { spendingBalanceSatang: 125 },
    ]);

    await expect(
      db.update(walletLedgerTransaction).set({ description: 'mutated' }).where(eq(walletLedgerTransaction.id, transaction!.id)).execute(),
    ).rejects.toThrow();
    await expect(
      db.delete(walletLedgerTransaction).where(eq(walletLedgerTransaction.id, transaction!.id)).execute(),
    ).rejects.toThrow();
    await expect(
      db.insert(walletLedgerPosting).values({
        transactionId: transaction!.id,
        accountId: spendingAccountId,
        amountSatang: 1,
      }).execute(),
    ).rejects.toThrow();

    const [unsealedTransaction] = await db.insert(walletLedgerTransaction).values({
      businessReference: `be109-unsealed-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
    }).returning();
    const [unsealedPosting] = await db.insert(walletLedgerPosting).values({
      transactionId: unsealedTransaction.id,
      accountId: spendingAccountId,
      amountSatang: 1,
    }).returning();
    await expect(
      db.update(walletLedgerPosting)
        .set({ transactionId: transaction!.id })
        .where(eq(walletLedgerPosting.id, unsealedPosting.id))
        .execute(),
    ).rejects.toThrow();
  });

  it('serializes posting changes against ledger sealing', async () => {
    await ensureWallet(studentId);
    const spendingAccountId = await getWalletAccountId(studentId, 'SPENDING');
    const suspenseAccountId = await getPlatformAccountId('PLATFORM_SUSPENSE');
    const [ledgerTransaction] = await db.insert(walletLedgerTransaction).values({
      businessReference: `be109-concurrent-seal-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
    }).returning();
    await db.insert(walletLedgerPosting).values([
      {
        transactionId: ledgerTransaction.id,
        accountId: spendingAccountId,
        amountSatang: 10,
      },
      {
        transactionId: ledgerTransaction.id,
        accountId: suspenseAccountId,
        amountSatang: -10,
      },
    ]);
    let releasePostingTransaction = () => {};
    let reportPostingInsert = () => {};
    const postingMayCommit = new Promise<void>((resolve) => {
      releasePostingTransaction = resolve;
    });
    const postingInserted = new Promise<void>((resolve) => {
      reportPostingInsert = resolve;
    });

    const postingTransaction = db.transaction(async (transaction) => {
      await transaction.insert(walletLedgerPosting).values({
        transactionId: ledgerTransaction.id,
        accountId: spendingAccountId,
        amountSatang: 1,
      });
      reportPostingInsert();
      await postingMayCommit;
    });
    await postingInserted;

    const sealingTransaction = db.transaction((transaction) =>
      transaction.update(walletLedgerTransaction)
        .set({ sealedAt: new Date() })
        .where(eq(walletLedgerTransaction.id, ledgerTransaction.id)),
    );
    await Bun.sleep(50);
    releasePostingTransaction();

    const outcomes = await Promise.allSettled([postingTransaction, sealingTransaction]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });

  it('replays matching idempotent work and rejects a changed request hash', async () => {
    const spendingAccountId = await getWalletAccountId(studentId, 'SPENDING');
    const suspenseAccountId = await getPlatformAccountId('PLATFORM_SUSPENSE');
    const key = crypto.randomUUID();
    const input = {
      businessReference: `be109-idempotent-${crypto.randomUUID()}`,
      eventType: 'TOP_UP' as const,
      postings: [
        { accountId: spendingAccountId, amountSatang: signedSatang(25) },
        { accountId: suspenseAccountId, amountSatang: signedSatang(-25) },
      ],
      idempotency: {
        principalUserId: studentId,
        operationScope: 'wallet.test',
        key,
        requestHash: 'same-request',
        expiresAt: new Date(Date.now() + 60_000),
      },
    };

    const first = await createSealedLedgerTransaction(input);
    const replay = await createSealedLedgerTransaction(input);
    expect(replay?.id).toBe(first?.id);
    await expect(createSealedLedgerTransaction({
      ...input,
      idempotency: { ...input.idempotency, requestHash: 'different-request' },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('detects and rebuilds balance and activity projections from the ledger', async () => {
    const [wallet] = await db.select().from(walletWallet).where(eq(walletWallet.userId, studentId));
    const [activity] = await db.select().from(walletActivity).where(eq(walletActivity.userId, studentId));

    await expect(db
      .update(walletWallet)
      .set({ spendingBalanceSatang: 1 })
      .where(eq(walletWallet.id, wallet.id))
      .execute()).rejects.toThrow();
    await db.update(walletActivity).set({ spendingDeltaSatang: 1 }).where(eq(walletActivity.id, activity.id));

    expect((await verifyWalletProjection(wallet.id)).matches).toBe(false);
    expect((await verifyWalletProjection(wallet.id)).matches).toBe(false);
    await rebuildWalletProjection(wallet.id);
    expect((await verifyWalletProjection(wallet.id)).matches).toBe(true);

    const revenueAccountId = await getPlatformAccountId('PLATFORM_REVENUE');
    const suspenseAccountId = await getPlatformAccountId('PLATFORM_SUSPENSE');
    const platformTransaction = await createSealedLedgerTransaction({
      businessReference: `be109-platform-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
      postings: [
        { accountId: revenueAccountId, amountSatang: signedSatang(1) },
        { accountId: suspenseAccountId, amountSatang: signedSatang(-1) },
      ],
    });
    await db.insert(walletActivity).values({
      ledgerTransactionId: platformTransaction!.id,
      userId: studentId,
      type: 'EARN',
      activityStatus: 'COMPLETED',
      earningsDeltaSatang: 1,
    });

    expect((await verifyWalletProjection(wallet.id)).matches).toBe(false);
    expect((await verifyWalletProjection(wallet.id)).matches).toBe(false);
    await rebuildWalletProjection(wallet.id);
    expect((await verifyWalletProjection(wallet.id)).matches).toBe(true);
  });

  it('rejects pre-sealed unbalanced rows and Money Policy mutation or overlap', async () => {
    await expect(db.insert(walletLedgerTransaction).values({
      businessReference: `be109-presealed-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
      sealedAt: new Date(),
    }).execute()).rejects.toThrow();

    const policy = await getEffectiveMoneyPolicy();
    await expect(
      db.update(paymentMoneyPolicyRevision)
        .set({ effectiveUntil: new Date('2099-01-01T00:00:00.000Z') })
        .where(eq(paymentMoneyPolicyRevision.id, policy.id))
        .execute(),
    ).rejects.toThrow();
    await expect(
      db.update(paymentMoneyPolicyRevision).set({ platformFeeBps: 201 }).where(eq(paymentMoneyPolicyRevision.id, policy.id)).execute(),
    ).rejects.toThrow();
    await expect(db.insert(paymentMoneyPolicyRevision).values({
      ...policy,
      id: crypto.randomUUID(),
      revision: policy.revision + 1,
      reason: 'overlap test',
    }).execute()).rejects.toThrow();
  });

  it('serializes concurrent Money Policy overlap checks', async () => {
    const policy = await getEffectiveMoneyPolicy();
    const revision = Math.floor(Math.random() * 1_000_000) + 10_000;
    const historicWindowStart = new Date(
      Date.UTC(1900, 0, 1) + Math.floor(Math.random() * 3_000_000_000_000),
    );
    const historicPolicy = {
      ...policy,
      effectiveFrom: historicWindowStart,
      effectiveUntil: new Date(historicWindowStart.getTime() + 1),
    };
    let releaseFirstTransaction = () => {};
    let reportFirstInsert = () => {};
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    const firstInserted = new Promise<void>((resolve) => {
      reportFirstInsert = resolve;
    });

    const firstTransaction = db.transaction(async (transaction) => {
      await transaction.insert(paymentMoneyPolicyRevision).values({
        ...historicPolicy,
        id: crypto.randomUUID(),
        revision,
        reason: 'concurrent policy A',
      });
      reportFirstInsert();
      await firstMayCommit;
    });
    await firstInserted;

    const secondTransaction = db.transaction((transaction) =>
      transaction.insert(paymentMoneyPolicyRevision).values({
        ...historicPolicy,
        id: crypto.randomUUID(),
        revision: revision + 1,
        reason: 'concurrent policy B',
      }),
    );
    await Bun.sleep(50);
    releaseFirstTransaction();

    const outcomes = await Promise.allSettled([firstTransaction, secondTransaction]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });
});
