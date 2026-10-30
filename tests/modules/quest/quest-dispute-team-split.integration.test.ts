import '@/app';
import { db, sql } from '@/database/client';
import {
  adminDisputeCase,
  adminDisputeTeamAllocation,
  adminDisputeTeamAllocationMember,
} from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { createAdminDisputeCase, resolveAdminDisputeCase } from '@/modules/quest/admin';
import { readQuestDisputeSummary } from '@/modules/quest/admin/quest-dispute-admin.service';
import {
  calculateTeamDisputeAmounts,
  readTeamDisputeSplit,
  settleDueTeamDisputeSplit,
  submitTeamDisputeSplit,
  teamDisputeSplitWindowMs,
} from '@/modules/quest/admin/quest-dispute-team-split.service';
import { runQuestLifecycleWorker } from '@/modules/quest/lifecycle';
import {
  ensureInitialMoneyPolicy,
  ensureWallet,
  positiveSatang,
  releaseFundingReservation,
  reserveSpending,
} from '@/modules/wallet';

import {
  fundTestWallet,
  readTestQuestEscrow,
  readTestWallet,
} from '../wallet/wallet-test-fixtures';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

let postgresAvailable = false;
let adminId = '';

const createMember = async (label: string) => {
  const id = crypto.randomUUID();
  await db.insert(authUser).values({
    id,
    email: `${label}-${id}@ku.th`,
    firstName: 'Split',
    lastName: label,
  });
  await ensureWallet(id);
  return id;
};

type TeamFixture = {
  questId: string;
  hirerId: string;
  teamId: string;
  memberIds: string[];
  leaderId: string;
  holdStartedAt: Date;
};

/** A failed GROUP + CANDIDATE Quest: every slot's funding sits in the 7-day hold. */
const createFailedTeamQuest = async (memberCount = 3): Promise<TeamFixture> => {
  const hirerId = await createMember('Hirer');
  const memberIds: string[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    memberIds.push(await createMember(`Member${index}`));
  }
  const fundingSatang = 1_000 * memberCount;
  await fundTestWallet(hirerId, 10_000);
  const questId = crypto.randomUUID();
  const reservation = await db.transaction((transaction) =>
    reserveSpending(transaction, {
      ownerUserId: hirerId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: positiveSatang(fundingSatang),
    })
  );
  const tagId = crypto.randomUUID();
  await db.insert(tag).values({ id: tagId, name: `Team split tag ${tagId}` });
  const holdStartedAt = new Date();
  await db.insert(quest).values({
    id: questId,
    hirerId,
    apiVersion: 'v2',
    title: 'Team split Quest',
    description: 'Failed Candidate Team Quest',
    condition: 'Complete the team task',
    mode: 'CANDIDATE',
    participation: 'GROUP',
    v2Mode: 'CANDIDATE',
    v2Participation: 'GROUP',
    questStatus: 'QUEST_FAILED',
    version: 1,
    rewardSatang: 1_000,
    questFundingTotalSatang: 1_000,
    fundingReservationId: reservation.id,
    policyRevisionId: reservation.policyRevisionId,
    platformFeeBps: 0,
    platformFeePerWorkerSatang: 0,
    questEscrowSatang: fundingSatang,
    tagId,
    headcount: memberCount,
    startTime: new Date(holdStartedAt.getTime() - 2 * 60 * 60 * 1000),
    dueAt: new Date(holdStartedAt.getTime() - 60 * 60 * 1000),
    proofRequired: true,
    failedAt: holdStartedAt,
    moneyHoldStartedAt: holdStartedAt,
    createdAt: holdStartedAt,
    updatedAt: holdStartedAt,
  });
  const teamId = crypto.randomUUID();
  await db.insert(questCandidateTeamV2).values({
    id: teamId,
    questId,
    leaderId: memberIds[0]!,
    name: 'Failed team',
    headcount: memberCount,
    state: 'TEAM_SELECTED',
  });
  const base = Date.now() - 10_000;
  await db.insert(questCandidateTeamV2Member).values(
    memberIds.map((memberId, index) => ({
      teamId,
      memberId,
      joinedAt: new Date(base + index),
    }))
  );
  await db.insert(questAssignment).values(
    memberIds.map((workerId) => ({
      questId,
      workerId,
      assignmentStatus: 'ASSIGNMENT_INCOMPLETE' as const,
    }))
  );
  return { questId, hirerId, teamId, memberIds, leaderId: memberIds[0]!, holdStartedAt };
};

const fileTeamCase = (fixture: TeamFixture, filerUserId = fixture.leaderId) =>
  createAdminDisputeCase({
    questId: fixture.questId,
    filerUserId,
    category: 'PROOF_REVIEW',
    submittedDetail: 'The team met the Quest Condition.',
  });

const approveTeamCase = (disputeCaseId: string, amountSatang: number, now?: Date) =>
  resolveAdminDisputeCase({
    adminId,
    disputeCaseId,
    expectedVersion: 1,
    requestKey: `team-split-approve-${disputeCaseId}`,
    reasonCode: 'DISPUTE_WORKER_MET_QUEST_CONDITION',
    outcome: 'DISPUTE_CASE_RESOLVED',
    amountSatang,
    now,
  });

const evenShares = (memberIds: string[], basisPoints: number[]) =>
  memberIds.map((memberId, index) => ({ memberId, percentageBasisPoints: basisPoints[index]! }));

const submitSplit = (
  fixture: TeamFixture,
  shares: { memberId: string; percentageBasisPoints: number }[],
  key = crypto.randomUUID(),
  actorId = fixture.leaderId,
  now?: Date
) => submitTeamDisputeSplit(actorId, fixture.questId, shares, key, now);

const readAllocation = async (disputeCaseId: string) => {
  const [allocation] = await db
    .select()
    .from(adminDisputeTeamAllocation)
    .where(eq(adminDisputeTeamAllocation.disputeCaseId, disputeCaseId));
  return allocation;
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
  } catch {
    return;
  }
  await ensureInitialMoneyPolicy();
  const email = `team-split-admin-${crypto.randomUUID()}@example.com`;
  const signUp = await createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  }).api.signUpEmail({
    body: {
      email,
      password: 'AdminPass1!',
      name: 'Split Admin',
      firstName: 'Split',
      lastName: 'Admin',
    },
  });
  if (!signUp.user?.id) throw new Error('Split Admin was not created.');
  adminId = signUp.user.id;
});

describe('calculateTeamDisputeAmounts', () => {
  it('pays the exact approved total and gives leftover satang to the largest remainders', () => {
    const memberIds = ['a', 'b', 'c'];
    const amounts = calculateTeamDisputeAmounts(
      1_000,
      evenShares(memberIds, [3_334, 3_333, 3_333])
    );
    expect(amounts.map(({ amountSatang }) => amountSatang)).toEqual([334, 333, 333]);
    expect(amounts.reduce((sum, { amountSatang }) => sum + amountSatang, 0)).toBe(1_000);
  });

  it('breaks equal remainders in roster order and allows a zero share', () => {
    const amounts = calculateTeamDisputeAmounts(1, evenShares(['a', 'b', 'c'], [5_000, 5_000, 0]));
    expect(amounts.map(({ amountSatang }) => amountSatang)).toEqual([1, 0, 0]);
  });

  it('rejects shares that do not total 10000 basis points', () => {
    expect(() =>
      calculateTeamDisputeAmounts(100, evenShares(['a', 'b'], [5_000, 4_000]))
    ).toThrow();
  });
});

describe('team Dispute Case filing', () => {
  it('lets only the team leader file, and stores the team on the case', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();

    await expect(fileTeamCase(fixture, fixture.memberIds[1])).rejects.toMatchObject({
      code: 'DISPUTE_CASE_TEAM_LEADER_ONLY',
    });
    const created = await fileTeamCase(fixture);
    expect(created.teamId).toBe(fixture.teamId);
    expect(created.filerUserId).toBe(fixture.leaderId);
  });

  it('shows the leader canFile and a member canFile=false with the leader as filer', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();

    const leaderView = await readQuestDisputeSummary(fixture.leaderId, fixture.questId);
    const memberView = await readQuestDisputeSummary(fixture.memberIds[1]!, fixture.questId);
    expect(leaderView).toMatchObject({ canFile: true, viewerRole: 'TEAM_LEADER' });
    expect(memberView).toMatchObject({ canFile: false, viewerRole: 'TEAM_MEMBER' });

    await fileTeamCase(fixture);
    const afterMember = await readQuestDisputeSummary(fixture.memberIds[1]!, fixture.questId);
    expect(afterMember?.teamCase).toMatchObject({ status: 'DISPUTE_CASE_PENDING' });
    expect(afterMember?.myCase).toBeNull();
  });
});

describe('Admin approval of a team Dispute Case', () => {
  it('opens an awaiting split for 24 hours and moves no money yet', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    const now = new Date();

    const result = await approveTeamCase(created.id, 1_500, now);
    expect(result.resourceSummary).toMatchObject({
      status: 'DISPUTE_CASE_RESOLVED',
      resolvedWorkerId: fixture.leaderId,
      resolvedAmountSatang: 1_500,
    });

    const allocation = await readAllocation(created.id);
    expect(allocation).toMatchObject({
      status: 'AWAITING_SPLIT',
      approvedAmountSatang: 1_500,
      leaderId: fixture.leaderId,
    });
    expect(allocation!.splitDeadlineAt.getTime()).toBe(now.getTime() + teamDisputeSplitWindowMs);
    for (const memberId of fixture.memberIds) {
      expect((await readTestWallet(memberId))!.earningsBalanceSatang).toBe(0);
    }
    expect(
      (await readTestQuestEscrow({ ownerUserId: fixture.hirerId, questId: fixture.questId }))!
        .remainingSatang
    ).toBe(3_000);
  });

  it('rejects an amount above what the hold can still pay', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    await expect(approveTeamCase(created.id, 3_001)).rejects.toMatchObject({
      code: 'DISPUTE_CASE_AMOUNT_EXCEEDS_HOLD',
    });
  });
});

describe('Leader split and payment', () => {
  it('pays each member by share, stores one Ledger Transaction per paid member, and replays', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    await approveTeamCase(created.id, 1_000);
    const shares = evenShares(fixture.memberIds, [3_334, 3_333, 3_333]);
    const key = crypto.randomUUID();

    const first = await submitSplit(fixture, shares, key);
    expect(first).toMatchObject({ kind: 'success' });
    const replay = await submitSplit(fixture, shares, key);
    expect(replay).toMatchObject({ kind: 'success' });

    const balances = await Promise.all(
      fixture.memberIds.map(async (id) => (await readTestWallet(id))!.earningsBalanceSatang)
    );
    expect(balances).toEqual([334, 333, 333]);
    expect(
      (await readTestQuestEscrow({ ownerUserId: fixture.hirerId, questId: fixture.questId }))!
        .remainingSatang
    ).toBe(2_000);

    const allocation = await readAllocation(created.id);
    expect(allocation).toMatchObject({ status: 'PAID', splitSource: 'LEADER' });
    const rows = await db
      .select()
      .from(adminDisputeTeamAllocationMember)
      .where(eq(adminDisputeTeamAllocationMember.allocationId, allocation!.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.ledgerTransactionId && row.paidAt)).toBe(true);
    expect(new Set(rows.map((row) => row.ledgerTransactionId)).size).toBe(3);

    const second = await submitSplit(fixture, shares);
    expect(second).toMatchObject({ kind: 'rejected', rejection: 'not-ready' });
  });

  it('rejects a non-leader, an incomplete or wrong-total split, and a late split', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    const approvedAt = new Date();
    await approveTeamCase(created.id, 900, approvedAt);

    expect(
      await submitSplit(
        fixture,
        evenShares(fixture.memberIds, [4_000, 3_000, 3_000]),
        undefined,
        fixture.memberIds[1]
      )
    ).toMatchObject({ kind: 'rejected', rejection: 'not-leader' });
    expect(
      await submitSplit(fixture, evenShares(fixture.memberIds, [4_000, 3_000, 2_000]))
    ).toMatchObject({ kind: 'rejected', rejection: 'invalid-split' });
    expect(
      await submitSplit(fixture, evenShares(fixture.memberIds.slice(0, 2), [5_000, 5_000]))
    ).toMatchObject({ kind: 'rejected', rejection: 'invalid-split' });
    expect(
      await submitSplit(
        fixture,
        evenShares(fixture.memberIds, [4_000, 3_000, 3_000]),
        undefined,
        fixture.leaderId,
        new Date(approvedAt.getTime() + teamDisputeSplitWindowMs)
      )
    ).toMatchObject({ kind: 'rejected', rejection: 'deadline-passed' });
    expect((await readAllocation(created.id))!.status).toBe('AWAITING_SPLIT');
  });

  it('exposes the split state to the leader and to members', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    await approveTeamCase(created.id, 1_000);

    const leaderView = await readTeamDisputeSplit(fixture.leaderId, fixture.questId);
    const memberView = await readTeamDisputeSplit(fixture.memberIds[2]!, fixture.questId);
    const hirerView = await readTeamDisputeSplit(fixture.hirerId, fixture.questId);
    expect(leaderView).toMatchObject({
      status: 'AWAITING_SPLIT',
      viewerIsLeader: true,
      canSubmitSplit: true,
      approvedAmountSatang: 1_000,
    });
    expect(memberView).toMatchObject({ viewerIsLeader: false, canSubmitSplit: false });
    expect(hirerView).toMatchObject({ outcome: 'not-authorized' });

    const summary = await readQuestDisputeSummary(fixture.memberIds[2]!, fixture.questId);
    expect(summary?.teamSplit).toMatchObject({ status: 'AWAITING_SPLIT', canSubmitSplit: false });
  });
});

describe('automatic equal split', () => {
  it('splits equally with leftover satang in roster order after the deadline', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    const approvedAt = new Date();
    await approveTeamCase(created.id, 1_000, approvedAt);
    const allocation = await readAllocation(created.id);

    expect(
      await settleDueTeamDisputeSplit(allocation!.id, new Date(approvedAt.getTime() + 1_000))
    ).toBe(false);
    expect(
      await settleDueTeamDisputeSplit(
        allocation!.id,
        new Date(approvedAt.getTime() + teamDisputeSplitWindowMs)
      )
    ).toBe(true);

    const balances = await Promise.all(
      fixture.memberIds.map(async (id) => (await readTestWallet(id))!.earningsBalanceSatang)
    );
    expect(balances).toEqual([334, 333, 333]);
    expect(await readAllocation(created.id)).toMatchObject({
      status: 'PAID',
      splitSource: 'AUTO_EQUAL',
    });
  });

  it('runs from the lifecycle worker', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    const approvedAt = new Date();
    await approveTeamCase(created.id, 600, approvedAt);

    const result = await runQuestLifecycleWorker({
      clock: { now: () => new Date(approvedAt.getTime() + teamDisputeSplitWindowMs + 1) },
    });
    expect(result.settledTeamDisputeSplitQuestIds).toContain(fixture.questId);
    expect((await readAllocation(created.id))!.status).toBe('PAID');
  });
});

describe('money hold and balance checks', () => {
  it('defers the day-7 hold release until the split is paid', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    await approveTeamCase(created.id, 1_000);
    // Age the hold so it ends one minute from now; the approval stays recorded.
    const holdStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 60_000);
    await db
      .update(quest)
      .set({ failedAt: holdStart, moneyHoldStartedAt: holdStart })
      .where(eq(quest.id, fixture.questId));

    const afterHoldEnds = new Date(Date.now() + 2 * 60 * 1000);
    const result = await runQuestLifecycleWorker({ clock: { now: () => afterHoldEnds } });
    expect(result.releasedFailedQuestIds).not.toContain(fixture.questId);
    expect(
      (await readTestQuestEscrow({ ownerUserId: fixture.hirerId, questId: fixture.questId }))!
        .status
    ).toBe('ACTIVE');

    expect(
      await submitSplit(fixture, evenShares(fixture.memberIds, [5_000, 2_500, 2_500]))
    ).toMatchObject({
      kind: 'success',
    });
    const afterPay = await runQuestLifecycleWorker({ clock: { now: () => afterHoldEnds } });
    expect(afterPay.releasedFailedQuestIds).toContain(fixture.questId);
  });

  it('pays from Spending Balance when the hold ended before the split', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    await approveTeamCase(created.id, 1_000);
    const reservation = (await readTestQuestEscrow({
      ownerUserId: fixture.hirerId,
      questId: fixture.questId,
    }))!;
    await db.transaction((transaction) =>
      releaseFundingReservation(transaction, {
        ownerUserId: fixture.hirerId,
        reservationId: reservation.id,
        operationReference: `test-release-${fixture.questId}`,
      })
    );
    const before = (await readTestWallet(fixture.hirerId))!.spendingBalanceSatang;

    expect(
      await submitSplit(fixture, evenShares(fixture.memberIds, [5_000, 2_500, 2_500]))
    ).toMatchObject({
      kind: 'success',
    });
    expect((await readTestWallet(fixture.hirerId))!.spendingBalanceSatang).toBe(before - 1_000);
    expect((await readTestWallet(fixture.memberIds[0]!))!.earningsBalanceSatang).toBe(500);
  });

  it('keeps the confirmed split unpaid and pays nobody when the Hirer cannot cover it', async () => {
    if (!postgresAvailable) return;
    const fixture = await createFailedTeamQuest();
    const created = await fileTeamCase(fixture);
    await approveTeamCase(created.id, 1_000);
    const reservation = (await readTestQuestEscrow({
      ownerUserId: fixture.hirerId,
      questId: fixture.questId,
    }))!;
    await db.transaction((transaction) =>
      releaseFundingReservation(transaction, {
        ownerUserId: fixture.hirerId,
        reservationId: reservation.id,
        operationReference: `test-release-${fixture.questId}`,
      })
    );
    // The Hirer spends the released funds before the Leader splits.
    const spendable = (await readTestWallet(fixture.hirerId))!.spendingBalanceSatang;
    await db.transaction((transaction) =>
      reserveSpending(transaction, {
        ownerUserId: fixture.hirerId,
        callerScope: 'quest',
        callerReference: crypto.randomUUID(),
        amountSatang: positiveSatang(spendable),
      })
    );

    const outcome = await submitSplit(
      fixture,
      evenShares(fixture.memberIds, [5_000, 2_500, 2_500])
    );
    expect(outcome).toMatchObject({ kind: 'success' });
    const allocation = await readAllocation(created.id);
    expect(allocation).toMatchObject({ status: 'SPLIT_CONFIRMED' });
    expect(allocation!.paymentFailureCode).not.toBeNull();
    for (const memberId of fixture.memberIds) {
      expect((await readTestWallet(memberId))!.earningsBalanceSatang).toBe(0);
    }

    await fundTestWallet(fixture.hirerId, 1_000);
    expect(await settleDueTeamDisputeSplit(allocation!.id, new Date())).toBe(true);
    expect(await readAllocation(created.id)).toMatchObject({
      status: 'PAID',
      paymentFailureCode: null,
    });
    expect((await readTestWallet(fixture.memberIds[0]!))!.earningsBalanceSatang).toBe(500);
  });
});

void adminDisputeCase;
