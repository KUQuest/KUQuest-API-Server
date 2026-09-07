import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questLocation } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  walletFundingReservation,
  walletIdempotencyKey,
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import {
  createQuestV2,
  publishQuestV2,
  type QuestV2CreateInput,
} from '@/modules/quest';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  releaseFundingReservation,
  signedSatang,
} from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const testEmail = `quest-v2-publish-${randomUUID()}@ku.th`;
const testPassword = 'TestStudent1!';
const authTestApp = new Elysia({ name: 'quest-v2-publish-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: testEmail,
    password: testPassword,
    firstName: 'Publish',
    lastName: 'Hirer',
  }),
);

let hirerId = '';
const blockedHirerId = randomUUID();
const tagId = randomUUID();
const questIds: string[] = [];
let sessionCookie = '';

const baseInput: QuestV2CreateInput = {
  title: 'Publish a poster',
  description: 'Create one poster',
  condition: { items: ['Use the KUQuest brand'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 1.03,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: false,
  locations: [],
};

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const fundHirer = async (userId: string, amountSatang: number) => {
  const wallet = await ensureWallet(userId);
  const [spendingAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(
      eq(walletLedgerAccount.walletId, wallet.id),
      eq(walletLedgerAccount.type, 'SPENDING'),
    ));
  const [suspenseAccount] = await db
    .select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  if (!spendingAccount || !suspenseAccount) throw new Error('Missing funding accounts');

  await createSealedLedgerTransaction({
    businessReference: `quest-v2-publish-funding-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spendingAccount.id, amountSatang: signedSatang(amountSatang) },
      { accountId: suspenseAccount.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const postPublish = (questId: string, key = `quest-v2-publish-http-${randomUUID()}`) =>
  app.handle(
    new Request(`http://localhost/api/v2/quests/${questId}/publish`, {
      method: 'POST',
      headers: {
        'idempotency-key': key,
        cookie: sessionCookie,
      },
    }),
  );

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();
  const loginResponse = await authTestApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    }),
  );
  if (loginResponse.status !== 200) {
    throw new Error(`Quest v2 publish test authentication failed: ${loginResponse.status}`);
  }
  const loginBody = (await loginResponse.json()) as { user: { id: string } };
  hirerId = loginBody.user.id;
  sessionCookie = getCookieHeader(loginResponse);

  await db.insert(authUser).values({
    id: blockedHirerId,
    email: `${blockedHirerId}@ku.th`,
    firstName: 'Blocked',
    lastName: 'Hirer',
  });
  await db.insert(tag).values({ id: tagId, name: `Publish ${tagId}` });
});

afterAll(async () => {
  await db.delete(quest).where(inArray(quest.id, questIds));
  const userIds = [hirerId, blockedHirerId].filter(Boolean);
  const reservations = await db
    .select({ id: walletFundingReservation.id, ownerUserId: walletFundingReservation.ownerUserId })
    .from(walletFundingReservation)
    .where(and(
      inArray(walletFundingReservation.ownerUserId, userIds),
      eq(walletFundingReservation.status, 'ACTIVE'),
    ));
  // Funding Reservation and ledger rows are immutable audit facts. Release
  // active test holds so teardown leaves no live Quest Escrow commitment.
  await Promise.all(reservations.map((reservation) =>
    db.transaction((transaction) => releaseFundingReservation(transaction, {
      ownerUserId: reservation.ownerUserId,
      reservationId: reservation.id,
      operationReference: `quest-v2-publish-test-cleanup-${randomUUID()}`,
    })),
  ));
  await db.delete(questLocation).where(inArray(questLocation.questId, questIds));
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest API v2 publish', () => {
  it('publishes a Draft with an atomic Quest Escrow snapshot and replays the result', async () => {
    await fundHirer(hirerId, 5_000);
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `quest-v2-publish-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const [beforeWallet] = await db
      .select({
        spendingBalanceSatang: walletWallet.spendingBalanceSatang,
        fundingReservedSatang: walletWallet.fundingReservedSatang,
      })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));
    const key = `quest-v2-publish-${randomUUID()}`;

    const published = await publishQuestV2(hirerId, created.quest.id, key);

    expect(published).toMatchObject({
      quest: {
        id: created.quest.id,
        state: 'QUEST_OPEN',
        questFundingTotal: 1.03,
      },
      questEscrow: {
        reservationId: expect.any(String),
        questFundingTotal: 1.03,
        questFundingTotalSatang: 103,
        questReward: 1,
        questRewardSatang: 100,
        platformFee: 0.03,
        platformFeeSatang: 3,
        escrowRequirement: 1.03,
        escrowRequirementSatang: 103,
        headcount: 1,
        platformFeeBps: 200,
        feeRoundingMode: 'UP',
        policyRevision: 1,
      },
    });
    if (!published || 'outcome' in published) throw new Error('Quest was not published');

    const [afterWallet] = await db
      .select({
        spendingBalanceSatang: walletWallet.spendingBalanceSatang,
        fundingReservedSatang: walletWallet.fundingReservedSatang,
      })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));
    expect(afterWallet).toEqual({
      spendingBalanceSatang: (beforeWallet?.spendingBalanceSatang ?? 0) - 103,
      fundingReservedSatang: (beforeWallet?.fundingReservedSatang ?? 0) + 103,
    });

    const [reservation] = await db
      .select()
      .from(walletFundingReservation)
      .where(and(
        eq(walletFundingReservation.ownerUserId, hirerId),
        eq(walletFundingReservation.callerScope, 'quest'),
        eq(walletFundingReservation.callerReference, created.quest.id),
      ));
    expect(reservation).toMatchObject({
      totalReservedSatang: 103,
      remainingSatang: 103,
      status: 'ACTIVE',
    });

    const replay = await publishQuestV2(hirerId, created.quest.id, key);
    expect(replay).toEqual(published);

    const [storedQuest] = await db
      .select({
        questStatus: quest.questStatus,
        rewardSatang: quest.rewardSatang,
        questFundingTotalSatang: quest.questFundingTotalSatang,
        fundingReservationId: quest.fundingReservationId,
        policyRevisionId: quest.policyRevisionId,
        platformFeeBps: quest.platformFeeBps,
        platformFeePerWorkerSatang: quest.platformFeePerWorkerSatang,
        questEscrowSatang: quest.questEscrowSatang,
      })
      .from(quest)
      .where(eq(quest.id, created.quest.id));
    expect(storedQuest).toMatchObject({
      questStatus: 'QUEST_OPEN',
      rewardSatang: 100,
      questFundingTotalSatang: 103,
      fundingReservationId: reservation?.id,
      platformFeeBps: 200,
      platformFeePerWorkerSatang: 3,
      questEscrowSatang: 103,
    });
  });

  it('returns the canonical open Quest and Quest Escrow snapshot through HTTP', async () => {
    await fundHirer(hirerId, 5_000);
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `quest-v2-publish-http-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const key = `quest-v2-publish-http-${randomUUID()}`;
    const response = await postPublish(created.quest.id, key);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        quest: { id: created.quest.id, state: 'QUEST_OPEN' },
        questEscrow: {
          questFundingTotal: 1.03,
          questReward: 1,
          platformFee: 0.03,
          escrowRequirement: 1.03,
          escrowRequirementSatang: 103,
          headcount: 1,
          platformFeeBps: 200,
          feeRoundingMode: 'UP',
          policyRevision: 1,
        },
      },
    });

    const replay = await postPublish(created.quest.id, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
  });

  it('reserves the inclusive Quest Funding Total for every GROUP headcount slot', async () => {
    await fundHirer(hirerId, 5_000);
    const created = await createQuestV2(
      hirerId,
      { ...baseInput, participation: 'GROUP', headcount: 3 },
      `quest-v2-publish-group-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const published = await publishQuestV2(
      hirerId,
      created.quest.id,
      `quest-v2-publish-group-${randomUUID()}`,
    );
    expect(published).toMatchObject({
      quest: { id: created.quest.id, state: 'QUEST_OPEN', participation: 'GROUP', headcount: 3 },
      questEscrow: {
        questFundingTotalSatang: 103,
        questRewardSatang: 100,
        platformFeeSatang: 3,
        escrowRequirementSatang: 309,
        headcount: 3,
      },
    });
    if (!published || 'outcome' in published) throw new Error('Quest was not published');
    expect(
      Number(published.questEscrow.escrowRequirementSatang),
    ).toBe((Number(published.questEscrow.questRewardSatang) + Number(published.questEscrow.platformFeeSatang)) * 3);

    const [reservation] = await db
      .select({ totalReservedSatang: walletFundingReservation.totalReservedSatang })
      .from(walletFundingReservation)
      .where(and(
        eq(walletFundingReservation.ownerUserId, hirerId),
        eq(walletFundingReservation.callerScope, 'quest'),
        eq(walletFundingReservation.callerReference, created.quest.id),
      ));
    expect(reservation).toEqual({ totalReservedSatang: 309 });
  });

  it('rolls back the publish idempotency row when a blocker is corrected and retried', async () => {
    await ensureWallet(blockedHirerId);
    const created = await createQuestV2(
      blockedHirerId,
      baseInput,
      `quest-v2-publish-blocked-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const key = `quest-v2-publish-blocked-${randomUUID()}`;
    const blocked = await publishQuestV2(blockedHirerId, created.quest.id, key);
    expect(blocked).toMatchObject({
      outcome: 'blocked',
      check: { canPublish: false },
    });
    if (!blocked || !('check' in blocked)) throw new Error('Expected a publish blocker');
    expect(blocked.check.blockingReasons).toContainEqual(
      expect.objectContaining({ code: 'INSUFFICIENT_SPENDING_BALANCE' }),
    );

    const [idempotency] = await db
      .select({ id: walletIdempotencyKey.id })
      .from(walletIdempotencyKey)
      .where(and(
        eq(walletIdempotencyKey.principalUserId, blockedHirerId),
        eq(walletIdempotencyKey.operationScope, 'quest.v2.publish'),
        eq(walletIdempotencyKey.key, key),
      ));
    expect(idempotency).toBeUndefined();

    await fundHirer(blockedHirerId, 103);
    const retry = await publishQuestV2(blockedHirerId, created.quest.id, key);
    expect(retry).toMatchObject({
      quest: { state: 'QUEST_OPEN', id: created.quest.id },
      questEscrow: { escrowRequirementSatang: 103 },
    });
  });

  it('rolls back Quest, Wallet, ledger, reservation, and idempotency state after a post-reservation failure', async () => {
    await fundHirer(hirerId, 5_000);
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `quest-v2-publish-post-reservation-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);
    await db.insert(questLocation).values({ questId: created.quest.id, label: null });

    const [beforeWallet] = await db
      .select({
        spendingBalanceSatang: walletWallet.spendingBalanceSatang,
        fundingReservedSatang: walletWallet.fundingReservedSatang,
      })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));
    const key = `quest-v2-publish-post-reservation-${randomUUID()}`;

    await expect(publishQuestV2(hirerId, created.quest.id, key)).rejects.toThrow(
      'has an invalid location label',
    );

    const [storedQuest] = await db
      .select({
        questStatus: quest.questStatus,
        rewardSatang: quest.rewardSatang,
        fundingReservationId: quest.fundingReservationId,
        policyRevisionId: quest.policyRevisionId,
        platformFeeBps: quest.platformFeeBps,
        questEscrowSatang: quest.questEscrowSatang,
      })
      .from(quest)
      .where(eq(quest.id, created.quest.id));
    expect(storedQuest).toEqual({
      questStatus: 'QUEST_DRAFT',
      rewardSatang: null,
      fundingReservationId: null,
      policyRevisionId: null,
      platformFeeBps: null,
      questEscrowSatang: null,
    });

    const [afterWallet] = await db
      .select({
        spendingBalanceSatang: walletWallet.spendingBalanceSatang,
        fundingReservedSatang: walletWallet.fundingReservedSatang,
      })
      .from(walletWallet)
      .where(eq(walletWallet.userId, hirerId));
    expect(afterWallet).toEqual(beforeWallet);
    expect(await db
      .select({ id: walletFundingReservation.id })
      .from(walletFundingReservation)
      .where(and(
        eq(walletFundingReservation.ownerUserId, hirerId),
        eq(walletFundingReservation.callerScope, 'quest'),
        eq(walletFundingReservation.callerReference, created.quest.id),
      ))).toEqual([]);
    expect(await db
      .select({ id: walletIdempotencyKey.id })
      .from(walletIdempotencyKey)
      .where(and(
        eq(walletIdempotencyKey.principalUserId, hirerId),
        eq(walletIdempotencyKey.operationScope, 'quest.v2.publish'),
        eq(walletIdempotencyKey.key, key),
      ))).toEqual([]);
  });

  it('rejects a changed request that reuses a completed publish key', async () => {
    await fundHirer(hirerId, 5_000);
    const first = await createQuestV2(
      hirerId,
      baseInput,
      `quest-v2-publish-key-first-${randomUUID()}`,
    );
    const second = await createQuestV2(
      hirerId,
      baseInput,
      `quest-v2-publish-key-second-${randomUUID()}`,
    );
    if (!('quest' in first) || !('quest' in second)) throw new Error('Quest creation failed');
    questIds.push(first.quest.id, second.quest.id);

    const key = `quest-v2-publish-reuse-${randomUUID()}`;
    const published = await publishQuestV2(hirerId, first.quest.id, key);
    expect(published).not.toHaveProperty('outcome');

    expect(await publishQuestV2(hirerId, second.quest.id, key)).toEqual({
      outcome: 'idempotency-key-reused',
    });
  });

  it('allows only one concurrent publish to create the Funding Reservation', async () => {
    await fundHirer(hirerId, 5_000);
    const created = await createQuestV2(
      hirerId,
      baseInput,
      `quest-v2-publish-concurrent-create-${randomUUID()}`,
    );
    if (!('quest' in created)) throw new Error(`Create failed: ${created.outcome}`);
    questIds.push(created.quest.id);

    const results = await Promise.all([
      publishQuestV2(hirerId, created.quest.id, `quest-v2-publish-race-a-${randomUUID()}`),
      publishQuestV2(hirerId, created.quest.id, `quest-v2-publish-race-b-${randomUUID()}`),
    ]);
    expect(results.filter((result) => result && !('outcome' in result))).toHaveLength(1);
    expect(
      results.filter((result) => result && 'outcome' in result && result.outcome === 'not-draft'),
    ).toHaveLength(1);

    const reservations = await db
      .select({ id: walletFundingReservation.id })
      .from(walletFundingReservation)
      .where(and(
        eq(walletFundingReservation.ownerUserId, hirerId),
        eq(walletFundingReservation.callerScope, 'quest'),
        eq(walletFundingReservation.callerReference, created.quest.id),
      ));
    expect(reservations).toHaveLength(1);
  });
});
