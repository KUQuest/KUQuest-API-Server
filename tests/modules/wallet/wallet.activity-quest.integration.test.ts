import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { walletLedgerAccount } from '@/database/schema/wallet.schema';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  getWalletActivities,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
  settleFundingReservation,
  signedSatang,
} from '@/modules/wallet';

import { beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';

const createMember = async (spendingSatang = 0) => {
  const userId = crypto.randomUUID();
  await db.insert(authUser).values({
    id: userId,
    email: `${userId}@ku.th`,
    firstName: 'Activity',
    lastName: 'Quest',
  });
  const wallet = await ensureWallet(userId);
  if (spendingSatang > 0) {
    const [spending] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(
        and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, 'SPENDING'))
      );
    const [suspense] = await db
      .select({ id: walletLedgerAccount.id })
      .from(walletLedgerAccount)
      .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
    await createSealedLedgerTransaction({
      businessReference: `activity-quest-top-up-${crypto.randomUUID()}`,
      eventType: 'TOP_UP',
      postings: [
        { accountId: spending.id, amountSatang: signedSatang(spendingSatang) },
        { accountId: suspense.id, amountSatang: signedSatang(-spendingSatang) },
      ],
    });
  }
  return userId;
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
});

describe('Wallet activity Quest link', () => {
  it('names the Quest on Hold, Earn, and Release activities and leaves a Top-up unlinked', async () => {
    const hirerId = await createMember(10_000);
    const workerId = await createMember();
    const questId = crypto.randomUUID();
    const otherQuestId = crypto.randomUUID();

    const reservation = await db.transaction((tx) =>
      reserveSpending(tx, {
        ownerUserId: hirerId,
        callerScope: 'quest',
        callerReference: questId,
        amountSatang: positiveSatang(3_000),
      })
    );
    await db.transaction((tx) =>
      settleFundingReservation(tx, {
        ownerUserId: hirerId,
        reservationId: reservation.id,
        settlementReference: `activity-quest-settle-${crypto.randomUUID()}`,
        recipientUserId: workerId,
        recipientAmountSatang: positiveSatang(1_000),
      })
    );
    await db.transaction((tx) =>
      releaseFundingReservation(tx, {
        ownerUserId: hirerId,
        reservationId: reservation.id,
        operationReference: `activity-quest-release-${crypto.randomUUID()}`,
      })
    );
    await db.transaction((tx) =>
      reserveSpending(tx, {
        ownerUserId: hirerId,
        callerScope: 'generic-workflow',
        callerReference: otherQuestId,
        amountSatang: positiveSatang(500),
      })
    );

    const hirerActivities = await getWalletActivities(hirerId);
    const byType = (type: string) => hirerActivities.filter((activity) => activity.type === type);
    expect(byType('TOP_UP').map((activity) => activity.questId)).toEqual([null]);
    expect(
      byType('HOLD')
        .map((activity) => activity.questId)
        .sort()
    ).toEqual([questId, null].sort());
    expect(byType('RELEASE').map((activity) => activity.questId)).toEqual([questId]);
    expect(
      hirerActivities
        .filter(
          (activity) => activity.fundingReservedDeltaSatang < 0 && activity.type !== 'RELEASE'
        )
        .map((activity) => activity.questId)
    ).toEqual([questId]);

    const workerActivities = await getWalletActivities(workerId);
    expect(workerActivities).toHaveLength(1);
    expect(workerActivities[0]).toMatchObject({ type: 'EARN', questId });
  });
});
