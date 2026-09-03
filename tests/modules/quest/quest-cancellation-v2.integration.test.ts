import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { auditRecord } from '@/database/schema/audit.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2UnderfilledConsent,
  questV2UnderfilledDecision,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  walletFundingReservation,
  walletLedgerAccount,
  walletWallet,
} from '@/database/schema/wallet.schema';
import { auth } from '@/modules/auth';
import {
  configureQuestWorkChatMembershipWriter,
  type QuestTransaction,
  type QuestWorkChatMembershipTransition,
} from '@/modules/quest';
import {
  createSealedLedgerTransaction,
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  reserveSpending,
  signedSatang,
} from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirerId = randomUUID();
const workerIds = [randomUUID(), randomUUID(), randomUUID()];
const otherMemberId = randomUUID();
const tagId = randomUUID();
const questIds: string[] = [];
let postgresAvailable = false;
let transitions: QuestWorkChatMembershipTransition[] = [];
let writerFailure: Error | undefined;

const successfulWriter = {
  applyQuestTransition: async (
    _transaction: QuestTransaction,
    transition: QuestWorkChatMembershipTransition,
  ) => {
    transitions.push(transition);
    if (writerFailure) throw writerFailure;
    return { conversationId: 'quest-cancellation-v2-test', outcome: 'APPLIED' as const };
  },
};

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const userId = headers.get('x-member-id') ?? hirerId;
  return { user: { id: userId }, session: { userId } } as never;
}) as never);

const request = (
  questId: string,
  memberId: string,
  key?: string,
  body?: unknown,
) => app.handle(new Request(`http://localhost/api/v2/quests/${questId}/cancel`, {
  method: 'POST',
  headers: {
    'x-member-id': memberId,
    ...(key === undefined ? {} : { 'idempotency-key': key }),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

const account = async (userId: string, type: 'SPENDING' | 'EARNINGS') => {
  const [wallet] = await db.select({ id: walletWallet.id })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));
  const [row] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(and(eq(walletLedgerAccount.walletId, wallet.id), eq(walletLedgerAccount.type, type)));
  return row.id;
};

const fundHirer = async (amountSatang: number) => {
  const spending = await account(hirerId, 'SPENDING');
  const [suspense] = await db.select({ id: walletLedgerAccount.id })
    .from(walletLedgerAccount)
    .where(eq(walletLedgerAccount.code, 'platform:PLATFORM_SUSPENSE'));
  await createSealedLedgerTransaction({
    businessReference: `quest-cancellation-v2-top-up-${randomUUID()}`,
    eventType: 'TOP_UP',
    postings: [
      { accountId: spending, amountSatang: signedSatang(amountSatang) },
      { accountId: suspense.id, amountSatang: signedSatang(-amountSatang) },
    ],
  });
};

const earningsBalance = async (userId: string) => {
  const [wallet] = await db.select({ balance: walletWallet.earningsBalanceSatang })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId));
  return wallet.balance;
};

const createV2Quest = async (input: {
  status: 'QUEST_DRAFT' | 'QUEST_OPEN' | 'QUEST_ASSIGNED' | 'QUEST_IN_PROGRESS' | 'QUEST_FAILED' | 'QUEST_COMPLETED';
  mode?: 'FIRST_COME_FIRST_SERVED' | 'CANDIDATE';
  participation?: 'SINGLE' | 'GROUP';
  workers?: string[];
  headcount?: number;
  rewardSatang?: number;
  platformFeeSatang?: number;
}) => {
  const mode = input.mode ?? 'FIRST_COME_FIRST_SERVED';
  const participation = input.participation ?? 'SINGLE';
  const workers = input.workers ?? [];
  const rewardSatang = input.rewardSatang ?? 1_000;
  const platformFeeSatang = input.platformFeeSatang ?? 20;
  const headcount = input.headcount ?? (participation === 'SINGLE' ? 1 : Math.max(2, workers.length));
  const questId = randomUUID();
  questIds.push(questId);

  await db.insert(quest).values({
    id: questId,
    hirerId: hirerId,
    apiVersion: 'v2',
    title: 'Quest cancellation v2 test',
    condition: 'Complete the work',
    mode: mode === 'CANDIDATE' ? 'CANDIDATE' : 'NO_CANDIDATE',
    participation: participation === 'GROUP' ? 'GROUP' : 'SOLO',
    v2Mode: mode,
    v2Participation: participation,
    questStatus: input.status,
    rewardSatang: input.status === 'QUEST_DRAFT' ? null : rewardSatang,
    questFundingTotalSatang: input.status === 'QUEST_DRAFT' ? null : rewardSatang + platformFeeSatang,
    platformFeeBps: input.status === 'QUEST_DRAFT' ? null : 200,
    platformFeePerWorkerSatang: input.status === 'QUEST_DRAFT' ? null : platformFeeSatang,
    questEscrowSatang: input.status === 'QUEST_DRAFT' ? null : (rewardSatang + platformFeeSatang) * headcount,
    tagId: input.status === 'QUEST_DRAFT' ? null : tagId,
    headcount,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });

  if (workers.length > 0) {
    await db.insert(questAssignment).values(workers.map((workerId, index) => ({
      questId,
      workerId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
      createdAt: new Date(Date.now() + index),
    })));
  }

  if (input.status !== 'QUEST_DRAFT') {
    await db.transaction((transaction) => reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang((rewardSatang + platformFeeSatang) * headcount),
    }));
    const [reservation] = await db.select({ id: walletFundingReservation.id, policyRevisionId: walletFundingReservation.policyRevisionId })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.callerReference, questId));
    await db.update(quest).set({
      fundingReservationId: reservation.id,
      policyRevisionId: reservation.policyRevisionId,
    }).where(eq(quest.id, questId));
  }

  return questId;
};

const selectCandidateTeam = async (questId: string, leaderId: string, workerIdsForTeam: string[]) => {
  const teamId = randomUUID();
  await db.insert(questCandidateTeamV2).values({
    id: teamId,
    questId,
    leaderId,
    name: 'Selected cancellation team',
    headcount: workerIdsForTeam.length,
    state: 'TEAM_SELECTED',
  });
  await db.insert(questCandidateTeamV2Member).values(workerIdsForTeam.map((memberId) => ({
    teamId,
    memberId,
  })));
  return teamId;
};

const completeUnderfilledAllocation = async (
  questId: string,
  workerIdsForAllocation: string[],
  headcount: number,
  rewardSatang: number,
) => {
  const decisionId = randomUUID();
  const now = new Date();
  const workerRewardPoolSatang = rewardSatang * headcount;
  const baseRewardSatang = Math.floor(workerRewardPoolSatang / workerIdsForAllocation.length);
  const remainderSatang = workerRewardPoolSatang % workerIdsForAllocation.length;
  await db.insert(questV2UnderfilledDecision).values({
    id: decisionId,
    questId,
    activeWorkerCount: workerIdsForAllocation.length,
    workerRewardPoolSatang,
    state: 'UNDERFILLED_COMPLETED',
    decision: 'PROCEED',
    decisionExpiresAt: now,
    consentExpiresAt: null,
    detectedAt: now,
    resolvedAt: now,
  });
  const assignments = await db.select({ id: questAssignment.id, workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(eq(questAssignment.questId, questId));
  await db.insert(questV2UnderfilledConsent).values(workerIdsForAllocation.map((workerId, index) => {
    const assignment = assignments.find(({ workerId: assignmentWorkerId }) => assignmentWorkerId === workerId);
    if (!assignment) throw new Error(`Assignment missing for ${workerId}`);
    return {
      decisionId,
      questId,
      assignmentId: assignment.id,
      workerId,
      rewardSatang: baseRewardSatang + (index < remainderSatang ? 1 : 0),
      decision: 'ACCEPT' as const,
      respondedAt: now,
    };
  }));
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }
  await ensureInitialMoneyPolicy();
  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Cancellation', lastName: 'Hirer' },
    ...workerIds.map((id, index) => ({ id, email: `${id}@ku.th`, firstName: 'Cancellation', lastName: `Worker ${index}` })),
    { id: otherMemberId, email: `${otherMemberId}@ku.th`, firstName: 'Other', lastName: 'Member' },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Quest cancellation v2 ${tagId}` });
  await ensureWallet(hirerId);
  for (const workerId of workerIds) await ensureWallet(workerId);
  await ensureWallet(otherMemberId);
  await fundHirer(100_000);
});

beforeEach(() => {
  transitions = [];
  writerFailure = undefined;
  authenticate();
  configureQuestWorkChatMembershipWriter(successfulWriter);
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  if (!postgresAvailable || questIds.length === 0) return;
  await db.delete(quest).where(inArray(quest.id, questIds));
  questIds.splice(0, questIds.length);
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
});

describe('Quest API v2 Hirer cancellation', () => {
  it('documents an authenticated bodyless cancellation command', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, {
        operationId?: string;
        security?: unknown;
        requestBody?: unknown;
        parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
        responses?: Record<string, unknown>;
      }>>;
    };
    const operation = document.paths['/api/v2/quests/{questId}/cancel']?.post;

    expect(operation?.operationId).toBe('cancelQuestV2');
    expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
    expect(operation?.requestBody).toBeUndefined();
    expect(operation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
    ]));
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining([
      '200', '400', '401', '403', '404', '409', '503',
    ]));
  });

  it('requires Idempotency-Key before authentication and rejects a non-owner', async () => {
    const questId = randomUUID();
    const missingKey = await request(questId, hirerId);
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    if (!postgresAvailable) return;
    const storedQuestId = await createV2Quest({ status: 'QUEST_DRAFT' });
    const response = await request(storedQuestId, otherMemberId, `cancel-v2-not-owner-${storedQuestId}`);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('QUEST_NOT_AUTHORIZED');
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, storedQuestId)))[0]?.status).toBe('QUEST_DRAFT');
  });

  it('cancels a Draft without money movement and closes the Quest atomically', async () => {
    if (!postgresAvailable) return;
    const questId = await createV2Quest({ status: 'QUEST_DRAFT' });
    const response = await request(questId, hirerId, `cancel-v2-draft-${questId}`);

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      questStatus: 'QUEST_CANCELLED',
      outcome: 'CANCELLED',
      paidSatang: 0,
      refundedSatang: 0,
    });
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_CANCELLED');
    expect(await db.select({ id: walletFundingReservation.id })
      .from(walletFundingReservation)
      .where(eq(walletFundingReservation.callerReference, questId))).toHaveLength(0);
    expect(await db.select({ action: auditRecord.action, resourceType: auditRecord.resourceType })
      .from(auditRecord)
      .where(eq(auditRecord.resourceId, questId))).toEqual([
      { action: 'QUEST_STATE_CHANGED', resourceType: 'QUEST' },
    ]);
    expect(transitions.map(({ type }) => type)).toEqual(['questBecameReadOnly']);
  });

  it.each([
    ['QUEST_OPEN', [], 0, 1_020],
    ['QUEST_ASSIGNED', [workerIds[0]], 200, 820],
    ['QUEST_IN_PROGRESS', [workerIds[1]], 1_000, 0],
  ] as const)('settles %s with integer-Satang values and replays the command', async (status, workers, expectedPaid, expectedRefund) => {
    if (!postgresAvailable) return;
    const before = await Promise.all(workers.map((workerId) => earningsBalance(workerId)));
    const questId = await createV2Quest({ status, workers: [...workers] });

    const first = await request(questId, hirerId, `cancel-v2-${questId}`);
    const replay = await request(questId, hirerId, `cancel-v2-${questId}`);
    const firstBody = await first.clone().json();

    expect(first.status).toBe(200);
    expect(firstBody.data).toEqual({
      questStatus: 'QUEST_CANCELLED',
      outcome: 'CANCELLED',
      paidSatang: expectedPaid,
      refundedSatang: expectedRefund,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(firstBody.data);
    expect(await Promise.all(workers.map((workerId, index) => earningsBalance(workerId).then((value) => value - before[index])))).toEqual(
      workers.map((_, index) => index === 0 ? expectedPaid : expectedPaid),
    );
    expect((await db.select({ status: questAssignment.assignmentStatus })
      .from(questAssignment)
      .where(eq(questAssignment.questId, questId))).map(({ status: assignmentState }) => assignmentState)).toEqual(
      workers.map(() => 'ASSIGNMENT_CANCELLED'),
    );
    expect(transitions.filter(({ questId: transitionQuestId }) => transitionQuestId === questId).map(({ type }) => type)).toEqual(
      workers.length === 0 ? ['questBecameReadOnly'] : ['workerBecameInactive', 'questBecameReadOnly'],
    );
  });

  it('uses the active Worker allocation for GROUP + FCFS and pays only the Team Leader for GROUP + CANDIDATE', async () => {
    if (!postgresAvailable) return;
    const fcfsQuestId = await createV2Quest({
      status: 'QUEST_ASSIGNED',
      participation: 'GROUP',
      workers: [workerIds[0], workerIds[1], workerIds[2]],
      rewardSatang: 1_001,
      platformFeeSatang: 20,
    });
    const fcfsResponse = await request(fcfsQuestId, hirerId, `cancel-v2-fcfs-${fcfsQuestId}`);
    expect(fcfsResponse.status).toBe(200);
    expect((await fcfsResponse.json()).data).toMatchObject({ paidSatang: 600, refundedSatang: 2_463 });

    const candidateWorkers = [workerIds[0], workerIds[1]];
    const candidateAssignedQuestId = await createV2Quest({
      status: 'QUEST_ASSIGNED',
      mode: 'CANDIDATE',
      participation: 'GROUP',
      workers: candidateWorkers,
    });
    await selectCandidateTeam(candidateAssignedQuestId, candidateWorkers[1], candidateWorkers);
    const leaderBefore = await earningsBalance(candidateWorkers[1]);
    const memberBefore = await earningsBalance(candidateWorkers[0]);
    const candidateResponse = await request(candidateAssignedQuestId, hirerId, `cancel-v2-candidate-${candidateAssignedQuestId}`);
    expect(candidateResponse.status).toBe(200);
    expect((await candidateResponse.json()).data).toMatchObject({ paidSatang: 400, refundedSatang: 1_640 });
    expect(await earningsBalance(candidateWorkers[1])).toBe(leaderBefore + 400);
    expect(await earningsBalance(candidateWorkers[0])).toBe(memberBefore);

    const candidateInProgressQuestId = await createV2Quest({
      status: 'QUEST_IN_PROGRESS',
      mode: 'CANDIDATE',
      participation: 'GROUP',
      workers: candidateWorkers,
    });
    await selectCandidateTeam(candidateInProgressQuestId, candidateWorkers[1], candidateWorkers);
    const inProgressLeaderBefore = await earningsBalance(candidateWorkers[1]);
    const inProgressMemberBefore = await earningsBalance(candidateWorkers[0]);
    const inProgressResponse = await request(candidateInProgressQuestId, hirerId, `cancel-v2-candidate-progress-${candidateInProgressQuestId}`);
    expect(inProgressResponse.status).toBe(200);
    expect((await inProgressResponse.json()).data).toMatchObject({ paidSatang: 2_000, refundedSatang: 0 });
    expect(await earningsBalance(candidateWorkers[1])).toBe(inProgressLeaderBefore + 2_000);
    expect(await earningsBalance(candidateWorkers[0])).toBe(inProgressMemberBefore);
  });

  it('uses the completed underfilled allocation for GROUP + FCFS cancellation', async () => {
    if (!postgresAvailable) return;
    const workers = [workerIds[0], workerIds[1]];
    const questId = await createV2Quest({
      status: 'QUEST_ASSIGNED',
      participation: 'GROUP',
      workers,
      headcount: 4,
      rewardSatang: 1_000,
      platformFeeSatang: 20,
    });
    await completeUnderfilledAllocation(questId, workers, 4, 1_000);

    const first = await earningsBalance(workers[0]);
    const second = await earningsBalance(workers[1]);
    const response = await request(questId, hirerId, `cancel-v2-underfilled-${questId}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ paidSatang: 800, refundedSatang: 3_280 });
    expect(await earningsBalance(workers[0])).toBe(first + 400);
    expect(await earningsBalance(workers[1])).toBe(second + 400);
  });

  it('rejects terminal States and preserves the Quest, while a reused key fails canonically', async () => {
    if (!postgresAvailable) return;
    const questId = await createV2Quest({ status: 'QUEST_FAILED', workers: [workerIds[0]] });
    const rejected = await request(questId, hirerId, `cancel-v2-terminal-${questId}`);
    expect(rejected.status).toBe(409);
    expect((await rejected.json()).error.code).toBe('QUEST_SETTLEMENT_NOT_ALLOWED');
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_FAILED');

    const openQuestId = await createV2Quest({ status: 'QUEST_OPEN' });
    const cancelled = await request(openQuestId, hirerId, 'cancel-v2-cross-request');
    expect(cancelled.status).toBe(200);
    const reusedByOtherMember = await request(openQuestId, otherMemberId, 'cancel-v2-cross-request');
    expect(reusedByOtherMember.status).toBe(409);
    expect((await reusedByOtherMember.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('rolls back money, assignment, Quest, audit, and command effects when Work Chat fails', async () => {
    if (!postgresAvailable) return;
    const questId = await createV2Quest({ status: 'QUEST_ASSIGNED', workers: [workerIds[0]] });
    const beforeEarnings = await earningsBalance(workerIds[0]);
    writerFailure = new Error('Work Chat unavailable');

    const response = await request(questId, hirerId, `cancel-v2-rollback-${questId}`);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');
    expect(await earningsBalance(workerIds[0])).toBe(beforeEarnings);
    expect((await db.select({ status: quest.questStatus }).from(quest).where(eq(quest.id, questId)))[0]?.status).toBe('QUEST_ASSIGNED');
    expect((await db.select({ status: questAssignment.assignmentStatus }).from(questAssignment).where(eq(questAssignment.questId, questId)))[0]?.status).toBe('ASSIGNMENT_ACTIVE');
    expect(await db.select({ id: auditRecord.id }).from(auditRecord).where(eq(auditRecord.resourceId, questId))).toHaveLength(0);
  });

  it('lets concurrent cancellation requests commit only once', async () => {
    if (!postgresAvailable) return;
    const questId = await createV2Quest({ status: 'QUEST_ASSIGNED', workers: [workerIds[2]] });
    const [first, second] = await Promise.all([
      request(questId, hirerId, `cancel-v2-concurrent-a-${questId}`),
      request(questId, hirerId, `cancel-v2-concurrent-b-${questId}`),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await db.select({ id: auditRecord.id }).from(auditRecord).where(eq(auditRecord.resourceId, questId))).toHaveLength(1);
  });
});
