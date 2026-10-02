import { app } from '@/app';
import { db } from '@/database/client';
import { quest, questAssignment, questConditionItem } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle';
import { ensureWallet, positiveSatang, reserveSpending } from '@/modules/wallet';
import { fundTestWallet } from '../wallet/wallet-test-fixtures';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';

const testPassword = 'TestPassword1!';

const createTestUser = async (email: string, firstName: string, lastName: string) => {
  const authApp = new Elysia({ name: `auth-${email}` }).use(
    createStagingTestAuthRoute({
      enabled: true,
      deploymentEnv: 'staging',
      email,
      password: testPassword,
      firstName,
      lastName,
    })
  );
  const response = await authApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: testPassword }),
    })
  );
  if (response.status !== 200) throw new Error(`Auth failed for ${email}`);
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';', 1)[0])
    .join('; ');
  const body = (await response.json()) as { user: { id: string } };
  await ensureWallet(body.user.id);
  return { id: body.user.id, cookie };
};

describe('Quest v2 dispute and hold contracts (B4, B5, B6)', () => {
  let hirer: { id: string; cookie: string };
  let worker1: { id: string; cookie: string };
  let worker2: { id: string; cookie: string };
  let tagId: string;

  beforeAll(async () => {
    const runId = crypto.randomUUID().slice(0, 8);
    hirer = await createTestUser(`hirer-${runId}@ku.th`, 'Hirer', 'User');
    worker1 = await createTestUser(`worker1-${runId}@ku.th`, 'Worker', 'One');
    worker2 = await createTestUser(`worker2-${runId}@ku.th`, 'Worker', 'Two');

    tagId = crypto.randomUUID();
    await db.insert(tag).values({ id: tagId, name: `DisputeTag-${runId}` });
  });

  const createFailedV2Quest = async (failedAt: Date) => {
    await fundTestWallet(hirer.id, 100_000);
    const questId = crypto.randomUUID();
    const reservation = await db.transaction((tx) =>
      reserveSpending(tx, {
        ownerUserId: hirer.id,
        callerScope: 'quest',
        callerReference: questId,
        amountSatang: positiveSatang(2_000),
      })
    );

    const now = new Date();
    await db.insert(quest).values({
      id: questId,
      hirerId: hirer.id,
      apiVersion: 'v2',
      title: 'Failed v2 Quest for dispute test',
      condition: 'Task condition',
      mode: 'NO_CANDIDATE',
      participation: 'GROUP',
      v2Mode: 'FIRST_COME_FIRST_SERVED',
      v2Participation: 'GROUP',
      questStatus: 'QUEST_FAILED',
      version: 1,
      rewardSatang: 1_000,
      questFundingTotalSatang: 2_000,
      fundingReservationId: reservation.id,
      policyRevisionId: reservation.policyRevisionId,
      platformFeeBps: 0,
      platformFeePerWorkerSatang: 0,
      questEscrowSatang: 2_000,
      tagId,
      headcount: 2,
      startTime: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      dueAt: new Date(now.getTime() - 60 * 60 * 1000),
      proofRequired: true,
      failedAt,
      createdAt: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      updatedAt: failedAt,
    });

    await db.insert(questConditionItem).values({
      questId,
      position: 0,
      text: 'Sample condition requirement',
    });
    await db.insert(questAssignment).values([
      {
        id: crypto.randomUUID(),
        questId,
        workerId: worker1.id,
        assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
      },
      {
        id: crypto.randomUUID(),
        questId,
        workerId: worker2.id,
        assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
      },
    ]);

    return { questId, reservationId: reservation.id };
  };

  it('B4 & B5: returns dispute block and 7-day money hold fields on failed Quest owner snapshot', async () => {
    const failedAt = new Date();
    const { questId } = await createFailedV2Quest(failedAt);

    const res = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data.dispute).toBeDefined();
    const dispute = body.data.dispute as Record<string, unknown>;
    expect(dispute.canFile).toBe(true);
    expect(typeof dispute.windowEndsAt).toBe('string');
    expect(dispute.myCase).toBeNull();

    expect(body.data.heldSatang).toBe(2_000);
    expect(typeof body.data.moneyHoldReleasesAt).toBe('string');
    const releaseTime = new Date(body.data.moneyHoldReleasesAt as string).getTime();
    expect(releaseTime).toBeGreaterThanOrEqual(failedAt.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000);
  });

  it('B4: returns dispute block on Worker participation snapshot and excludes hold internals', async () => {
    const failedAt = new Date();
    const { questId } = await createFailedV2Quest(failedAt);

    const res = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
        headers: { cookie: worker1.cookie },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };

    expect(body.data.dispute).toBeDefined();
    const dispute = body.data.dispute as Record<string, unknown>;
    expect(dispute.canFile).toBe(true);
    expect(typeof dispute.windowEndsAt).toBe('string');
    expect(dispute.myCase).toBeNull();

    expect(body.data.heldSatang).toBeUndefined();
    expect(body.data.moneyHoldReleasesAt).toBeUndefined();
  });

  it('B4: isolates myCase per viewer and supports group Quest multi-filer', async () => {
    const failedAt = new Date();
    const { questId } = await createFailedV2Quest(failedAt);

    // Worker 1 files dispute
    const fileRes = await app.handle(
      new Request(`http://localhost/api/v1/quests/${questId}/disputes`, {
        method: 'POST',
        headers: { cookie: worker1.cookie },
      })
    );
    expect(fileRes.status).toBe(200);

    // Worker 1 now sees myCase and canFile=false
    const w1Res = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
        headers: { cookie: worker1.cookie },
      })
    );
    const w1Body = (await w1Res.json()) as { data: Record<string, unknown> };
    const w1Dispute = w1Body.data.dispute as Record<string, unknown>;
    expect(w1Dispute.canFile).toBe(false);
    expect(w1Dispute.myCase).toMatchObject({
      status: 'DISPUTE_CASE_PENDING',
    });

    // Hirer still sees myCase=null and canFile=true
    const hirerRes = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      })
    );
    const hirerBody = (await hirerRes.json()) as { data: Record<string, unknown> };
    const hirerDispute = hirerBody.data.dispute as Record<string, unknown>;
    expect(hirerDispute.canFile).toBe(true);
    expect(hirerDispute.myCase).toBeNull();

    // Worker 2 still sees myCase=null and canFile=true (group quest rule)
    const w2Res = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
        headers: { cookie: worker2.cookie },
      })
    );
    const w2Body = (await w2Res.json()) as { data: Record<string, unknown> };
    const w2Dispute = w2Body.data.dispute as Record<string, unknown>;
    expect(w2Dispute.canFile).toBe(true);
    expect(w2Dispute.myCase).toBeNull();
  });

  it('B4: returns canFile=false and 409 DISPUTE_WINDOW_CLOSED after 1-day window closes', async () => {
    // Quest failed 2 days ago
    const failedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { questId } = await createFailedV2Quest(failedAt);

    const partRes = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
        headers: { cookie: worker1.cookie },
      })
    );
    const partBody = (await partRes.json()) as { data: Record<string, unknown> };
    const dispute = partBody.data.dispute as Record<string, unknown>;
    expect(dispute.canFile).toBe(false);

    // Attempting to file returns 409 DISPUTE_WINDOW_CLOSED
    const fileRes = await app.handle(
      new Request(`http://localhost/api/v1/quests/${questId}/disputes`, {
        method: 'POST',
        headers: { cookie: worker1.cookie },
      })
    );
    expect(fileRes.status).toBe(409);
    const fileBody = (await fileRes.json()) as { error: { code: string } };
    expect(fileBody.error.code).toBe('DISPUTE_WINDOW_CLOSED');
  });

  it('B4: returns dispute: null for cancelled Quest', async () => {
    const questId = crypto.randomUUID();
    const now = new Date();
    await db.insert(quest).values({
      id: questId,
      hirerId: hirer.id,
      apiVersion: 'v2',
      title: 'Cancelled v2 Quest',
      condition: 'Task condition',
      mode: 'NO_CANDIDATE',
      participation: 'SOLO',
      v2Mode: 'FIRST_COME_FIRST_SERVED',
      v2Participation: 'SINGLE',
      questStatus: 'QUEST_CANCELLED',
      version: 1,
      rewardSatang: 1_000,
      questFundingTotalSatang: 1_000,
      tagId,
      headcount: 1,
      startTime: now,
      dueAt: new Date(now.getTime() + 60 * 60 * 1000),
      cancelledAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(questConditionItem).values({
      questId,
      position: 0,
      text: 'Sample condition requirement',
    });

    const res = await app.handle(
      new Request(`http://localhost/api/v2/quests/${questId}`, {
        headers: { cookie: hirer.cookie },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.dispute).toBeNull();
  });

  it('B6: lifecycle worker closes dispute window after 1 day once per transition', async () => {
    const failedAt = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    const { questId } = await createFailedV2Quest(failedAt);

    // Pass 1: closes window and emits DISPUTE_WINDOW_CLOSED
    const result1 = await runQuestLifecycleWorker({
      autoApprove: async () => [],
    });
    expect(result1.closedDisputeWindowQuestIds).toContain(questId);

    const [questRow] = await db
      .select({ disputeWindowClosedAt: quest.disputeWindowClosedAt })
      .from(quest)
      .where(eq(quest.id, questId));
    expect(questRow?.disputeWindowClosedAt).not.toBeNull();

    // Pass 2: does not re-emit (once per transition)
    const result2 = await runQuestLifecycleWorker({
      autoApprove: async () => [],
    });
    expect(result2.closedDisputeWindowQuestIds).not.toContain(questId);
  });
});
