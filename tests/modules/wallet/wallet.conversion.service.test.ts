import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  walletActivity,
  walletEarningsConversion,
  walletIdempotencyKey,
  walletLedgerAccount,
  walletLedgerPosting,
  walletLedgerTransaction,
  walletWallet,
} from '@/database/schema/wallet.schema';
import {
  changeWalletStatus,
  convertEarnings,
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  MoneyDomainError,
  signedSatang,
  type Satang,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const createStudent = async (_prefix: string) => {
  const id = crypto.randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${id}@ku.th`,
    firstName: 'Conversion',
    lastName: 'Test',
  });
  const wallet = await ensureWallet(id);
  return { id, wallet };
};

const accountId = async (
  walletId: string,
  type: 'SPENDING' | 'EARNINGS' | 'PLATFORM_SUSPENSE',
) => {
  const [account] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(
      type === 'EARNINGS' || type === 'SPENDING'
        ? eq(walletLedgerAccount.walletId, walletId)
        : eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'),
      eq(walletLedgerAccount.type, type),
    ));
  if (!account) throw new Error(`Missing ${type} account`);
  return account.id;
};

const creditEarnings = async (walletId: string, amountSatang: number, reference: string) => {
  const earningsId = await accountId(walletId, 'EARNINGS');
  const suspenseId = await accountId(walletId, 'PLATFORM_SUSPENSE');
  await createSealedLedgerTransaction({
    businessReference: reference,
    eventType: 'ADJUSTMENT',
    postings: [
      { accountId: earningsId, amountSatang: signedSatang(amountSatang) },
      { accountId: suspenseId, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const earningsConversionInput = (principalUserId: string, amountSatang: number, key: string = crypto.randomUUID()) => ({
  principalUserId,
  amountSatang: amountSatang as Satang,
  idempotency: {
    key,
  },
});

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
});

describe('Earnings Conversion service', () => {
  it('moves exact satang, seals balanced postings, and rebuilds projections atomically', async () => {
    const { id, wallet } = await createStudent('be110-success');
    await creditEarnings(wallet.id, 500, `be110-credit-${crypto.randomUUID()}`);

    const conversion = await convertEarnings(earningsConversionInput(id, 125));
    expect(conversion).toMatchObject({
      principalUserId: id,
      amountSatang: 125,
      id: expect.any(String),
      businessReference: expect.stringContaining('wallet.earnings-conversion'),
    });

    const [updatedWallet] = await db.select().from(walletWallet).where(eq(walletWallet.id, wallet.id));
    expect(updatedWallet).toMatchObject({
      spendingBalanceSatang: 125,
      earningsBalanceSatang: 375,
    });

    const postings = await db
      .select({ type: walletLedgerAccount.type, amountSatang: walletLedgerPosting.amountSatang })
      .from(walletLedgerPosting)
      .innerJoin(walletLedgerAccount, eq(walletLedgerPosting.accountId, walletLedgerAccount.id))
      .where(eq(walletLedgerPosting.transactionId, conversion.ledgerTransactionId));
    expect(postings.sort((left, right) => left.type.localeCompare(right.type))).toEqual([
      { type: 'EARNINGS', amountSatang: -125 },
      { type: 'SPENDING', amountSatang: 125 },
    ]);

    const [activity] = await db
      .select()
      .from(walletActivity)
      .where(eq(walletActivity.ledgerTransactionId, conversion.ledgerTransactionId));
    expect(activity).toMatchObject({
      type: 'CONVERT',
      activityStatus: 'COMPLETED',
      spendingDeltaSatang: 125,
      earningsDeltaSatang: -125,
    });
    const [record] = await db
      .select()
      .from(walletEarningsConversion)
      .where(eq(walletEarningsConversion.ledgerTransactionId, conversion.ledgerTransactionId));
    expect(record).toMatchObject({
      principalUserId: id,
      amountSatang: 125,
      ledgerTransactionId: conversion.ledgerTransactionId,
    });
  });

  it('preserves total Wallet capacity when converting at the capacity limit', async () => {
    const { id, wallet } = await createStudent('be110-capacity');
    await creditEarnings(wallet.id, 2_000_000_000, `be110-credit-${crypto.randomUUID()}`);

    await convertEarnings(earningsConversionInput(id, 70_000_000));

    const [updatedWallet] = await db.select().from(walletWallet).where(eq(walletWallet.id, wallet.id));
    expect(updatedWallet).toMatchObject({
      spendingBalanceSatang: 70_000_000,
      earningsBalanceSatang: 1_930_000_000,
    });
  });

  it('replays the original conversion and rejects a conflicting retry', async () => {
    const { id, wallet } = await createStudent('be110-idempotency');
    await creditEarnings(wallet.id, 500, `be110-credit-${crypto.randomUUID()}`);
    const input = earningsConversionInput(id, 125, `be110-key-${crypto.randomUUID()}`);

    const first = await convertEarnings(input);
    const replay = await convertEarnings(input);
    expect(replay).toEqual(first);

    await changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'FROZEN',
      actorUserId: id,
      reason: 'Freeze Wallet for retry test',
    });
    expect(await convertEarnings(input)).toEqual(first);
    await changeWalletStatus({
      walletId: wallet.id,
      toStatus: 'ACTIVE',
      actorUserId: id,
      reason: 'Resume Wallet after retry test',
    });

    await expect(convertEarnings({
      ...input,
      amountSatang: 126 as Satang,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });

    const conversions = await db
      .select({ id: walletLedgerTransaction.id })
      .from(walletLedgerTransaction)
      .where(and(
        eq(walletLedgerTransaction.eventType, 'EARNINGS_CONVERSION'),
        eq(walletLedgerTransaction.createdByUserId, id),
      ));
    expect(conversions).toHaveLength(1);
  });

  it('replays concurrent matching requests as one conversion', async () => {
    const { id, wallet } = await createStudent('be110-concurrent-retry');
    await creditEarnings(wallet.id, 500, `be110-credit-${crypto.randomUUID()}`);
    const input = earningsConversionInput(id, 125, `be110-key-${crypto.randomUUID()}`);

    const [first, replay] = await Promise.all([
      convertEarnings(input),
      convertEarnings(input),
    ]);

    expect(replay).toEqual(first);
    const conversions = await db
      .select()
      .from(walletEarningsConversion)
      .where(eq(walletEarningsConversion.principalUserId, id));
    expect(conversions).toHaveLength(1);
  });

  it('keeps deterministic business references distinct for delimiter-bearing identities', async () => {
    const suffix = crypto.randomUUID();
    const firstId = `be110-reference:${suffix}:a`;
    const secondId = `be110-reference:${suffix}`;
    await db.insert(authUser).values([
      { id: firstId, email: `be110-reference-a-${suffix}@ku.th`, firstName: 'First', lastName: 'Reference' },
      { id: secondId, email: `be110-reference-b-${suffix}@ku.th`, firstName: 'Second', lastName: 'Reference' },
    ]);
    const firstWallet = await ensureWallet(firstId);
    const secondWallet = await ensureWallet(secondId);
    await creditEarnings(firstWallet.id, 500, `be110-credit-a-${suffix}`);
    await creditEarnings(secondWallet.id, 500, `be110-credit-b-${suffix}`);

    const [first, second] = await Promise.all([
      convertEarnings(earningsConversionInput(firstId, 125, 'b')),
      convertEarnings(earningsConversionInput(secondId, 125, 'a:b')),
    ]);

    expect(first.businessReference).not.toBe(second.businessReference);
  });

  it('records a later correction as a separate linked ledger transaction', async () => {
    const { id, wallet } = await createStudent('be110-correction');
    await creditEarnings(wallet.id, 500, `be110-credit-${crypto.randomUUID()}`);
    const conversion = await convertEarnings(earningsConversionInput(id, 125));
    const spendingId = await accountId(wallet.id, 'SPENDING');
    const earningsId = await accountId(wallet.id, 'EARNINGS');
    const correctionInput = {
      businessReference: `be110-correction-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT' as const,
      correctionOfTransactionId: conversion.ledgerTransactionId,
      createdByUserId: id,
      postings: [
        { accountId: spendingId, amountSatang: signedSatang(-125) },
        { accountId: earningsId, amountSatang: signedSatang(125) },
      ],
    };

    const correction = await createSealedLedgerTransaction(correctionInput);

    expect(correction).toMatchObject({
      correctionOfTransactionId: conversion.ledgerTransactionId,
      sealedAt: expect.any(Date),
    });
    expect(correction.id).not.toBe(conversion.ledgerTransactionId);
    const [updatedWallet] = await db.select().from(walletWallet).where(eq(walletWallet.id, wallet.id));
    expect(updatedWallet).toMatchObject({
      spendingBalanceSatang: 0,
      earningsBalanceSatang: 500,
    });
  });

  it('rejects a correction linked to an unsealed ledger transaction', async () => {
    const { id, wallet } = await createStudent('be110-unsealed-correction');
    const spendingId = await accountId(wallet.id, 'SPENDING');
    const earningsId = await accountId(wallet.id, 'EARNINGS');
    const [unsealed] = await db.insert(walletLedgerTransaction).values({
      businessReference: `be110-unsealed-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
    }).returning();

    await expect(createSealedLedgerTransaction({
      businessReference: `be110-invalid-correction-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
      correctionOfTransactionId: unsealed.id,
      createdByUserId: id,
      postings: [
        { accountId: spendingId, amountSatang: signedSatang(-125) },
        { accountId: earningsId, amountSatang: signedSatang(125) },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_LEDGER_CORRECTION' });
  });

  it('rejects a correction whose postings belong to a different Wallet', async () => {
    const first = await createStudent('be110-correction-owner-a');
    const second = await createStudent('be110-correction-owner-b');
    await creditEarnings(first.wallet.id, 500, `be110-credit-a-${crypto.randomUUID()}`);
    await creditEarnings(second.wallet.id, 500, `be110-credit-b-${crypto.randomUUID()}`);
    const firstConversion = await convertEarnings(earningsConversionInput(first.id, 125));
    await convertEarnings(earningsConversionInput(second.id, 125));
    const secondSpendingId = await accountId(second.wallet.id, 'SPENDING');
    const secondEarningsId = await accountId(second.wallet.id, 'EARNINGS');

    await expect(createSealedLedgerTransaction({
      businessReference: `be110-cross-wallet-correction-${crypto.randomUUID()}`,
      eventType: 'ADJUSTMENT',
      correctionOfTransactionId: firstConversion.ledgerTransactionId,
      createdByUserId: first.id,
      postings: [
        { accountId: secondSpendingId, amountSatang: signedSatang(-125) },
        { accountId: secondEarningsId, amountSatang: signedSatang(125) },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_LEDGER_CORRECTION' });
  });

  it('fails without a partial effect for invalid, out-of-policy, and insufficient amounts', async () => {
    const { id, wallet } = await createStudent('be110-failure');
    await creditEarnings(wallet.id, 500, `be110-credit-${crypto.randomUUID()}`);
    const before = await db.select().from(walletWallet).where(eq(walletWallet.id, wallet.id));

    await expect(convertEarnings(earningsConversionInput(id, 1.5))).rejects.toMatchObject({ code: 'INVALID_SATANG' });
    await expect(convertEarnings(earningsConversionInput(id, 99))).rejects.toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
    await expect(convertEarnings(earningsConversionInput(id, 70_000_001))).rejects.toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
    await expect(convertEarnings(earningsConversionInput(id, 501))).rejects.toMatchObject({ code: 'INSUFFICIENT_EARNINGS_BALANCE' });

    const after = await db.select().from(walletWallet).where(eq(walletWallet.id, wallet.id));
    expect(after).toEqual(before);
    const conversions = await db
      .select()
      .from(walletLedgerTransaction)
      .where(and(
        eq(walletLedgerTransaction.eventType, 'EARNINGS_CONVERSION'),
        eq(walletLedgerTransaction.createdByUserId, id),
      ));
    expect(conversions).toHaveLength(0);
    const conversionRecords = await db
      .select()
      .from(walletEarningsConversion)
      .where(eq(walletEarningsConversion.principalUserId, id));
    expect(conversionRecords).toHaveLength(0);
    const idempotencyRecords = await db
      .select()
      .from(walletIdempotencyKey)
      .where(eq(walletIdempotencyKey.principalUserId, id));
    expect(idempotencyRecords).toHaveLength(0);
  });

  it('blocks every non-active Wallet status with a typed error', async () => {
    const { id, wallet } = await createStudent('be110-status');
    await creditEarnings(wallet.id, 500, `be110-credit-${crypto.randomUUID()}`);

    for (const status of ['FROZEN', 'SUSPENDED', 'CLOSED'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await changeWalletStatus({
        walletId: wallet.id,
        toStatus: status,
        actorUserId: id,
        reason: `Set Wallet status to ${status}`,
      });
      // eslint-disable-next-line no-await-in-loop
      await expect(convertEarnings(earningsConversionInput(id, 125))).rejects.toMatchObject({
        code: 'WALLET_NOT_ACTIVE',
      });
    }
  });

  it('serializes concurrent conversions against the Earnings Balance', async () => {
    const { id, wallet } = await createStudent('be110-concurrent');
    await creditEarnings(wallet.id, 500, `be110-credit-${crypto.randomUUID()}`);

    const outcomes = await Promise.allSettled([
      convertEarnings(earningsConversionInput(id, 300, `be110-key-a-${crypto.randomUUID()}`)),
      convertEarnings(earningsConversionInput(id, 300, `be110-key-b-${crypto.randomUUID()}`)),
    ]);
    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find(({ status }) => status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(MoneyDomainError);
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('INSUFFICIENT_EARNINGS_BALANCE');

    const [updatedWallet] = await db.select().from(walletWallet).where(eq(walletWallet.id, wallet.id));
    expect(updatedWallet).toMatchObject({ spendingBalanceSatang: 300, earningsBalanceSatang: 200 });
  });
});
