import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  paymentMoneyPolicyRevision,
  walletActivity,
  walletLedgerAccount,
  walletLedgerTransaction,
  walletStatusHistory,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  getEffectiveMoneyPolicy,
  verifyWalletProjection,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const studentId = `be109-${crypto.randomUUID()}`;

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

  it('initializes and reads the versioned Money Policy in satang', async () => {
    const created = await ensureInitialMoneyPolicy();
    const effective = await getEffectiveMoneyPolicy();

    expect(created.revision).toBe(1);
    expect(effective.minimumTopUpSatang).toBe(100);
    expect(effective.maximumTopUpSatang).toBe(70_000_000);
    expect(effective.platformFeeBps).toBe(200);
    expect(effective.quoteLifetimeSeconds).toBe(300);
  });

  it('seals a balanced transaction and writes an atomic activity projection', async () => {
    const [spending] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(and(
        eq(walletLedgerAccount.userId, studentId),
        eq(walletLedgerAccount.type, 'SPENDING'),
      ));
    const [suspense] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));

    const transaction = await createSealedLedgerTransaction({
      businessReference: `be109-top-up-${crypto.randomUUID()}`,
      eventType: 'TOP_UP',
      postings: [
        { accountId: spending.id, amountSatang: 125 },
        { accountId: suspense.id, amountSatang: -125 },
      ],
    });

    expect(transaction?.sealedAt).toBeInstanceOf(Date);
    expect(await db.select().from(walletActivity).where(eq(walletActivity.ledgerTransactionId, transaction!.id))).toMatchObject([
      { activityStatus: 'COMPLETED', spendingDeltaSatang: 125, earningsDeltaSatang: 0 },
    ]);
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
      db.delete(walletActivity).where(eq(walletActivity.ledgerTransactionId, transaction!.id)).execute(),
    ).rejects.toThrow();
  });

  it('replays matching idempotent work and rejects a changed request hash', async () => {
    const [spending] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(and(eq(walletLedgerAccount.userId, studentId), eq(walletLedgerAccount.type, 'SPENDING')));
    const [suspense] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
    const key = crypto.randomUUID();
    const input = {
      businessReference: `be109-idempotent-${crypto.randomUUID()}`,
      eventType: 'TOP_UP' as const,
      postings: [
        { accountId: spending.id, amountSatang: 25 },
        { accountId: suspense.id, amountSatang: -25 },
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

    await db.update(walletWallet).set({ spendingBalanceSatang: 1 }).where(eq(walletWallet.id, wallet.id));
    await db.update(walletActivity).set({ spendingDeltaSatang: 1 }).where(eq(walletActivity.id, activity.id));

    expect((await verifyWalletProjection(wallet.id)).matches).toBe(false);
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
      db.update(paymentMoneyPolicyRevision).set({ platformFeeBps: 201 }).where(eq(paymentMoneyPolicyRevision.id, policy.id)).execute(),
    ).rejects.toThrow();
    await expect(db.insert(paymentMoneyPolicyRevision).values({
      ...policy,
      id: crypto.randomUUID(),
      revision: policy.revision + 1,
      reason: 'overlap test',
    }).execute()).rejects.toThrow();
  });
});
