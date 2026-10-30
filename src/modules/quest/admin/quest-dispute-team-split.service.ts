import { db } from '@/database/client';
import {
  adminDisputeCase,
  adminDisputeTeamAllocation,
  adminDisputeTeamAllocationMember,
  type DisputeTeamAllocationSource,
  type DisputeTeamAllocationStatus,
} from '@/database/schema/admin.schema';
import {
  quest,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
} from '@/database/schema/quest.schema';
import {
  MoneyDomainError,
  positiveSatang,
  readDisputeFundsAvailable,
  settleDisputeCase,
  type WalletTransaction,
} from '@/modules/wallet';

import { and, asc, eq, ne, sql } from 'drizzle-orm';

import {
  runQuestCommand,
  sha256Json,
  type QuestCommandResult,
  type QuestCommandWork,
} from '../shared/command/quest-command.service';
import { loadMemberSummaries } from '../shared/member-summary';
import {
  calculateTeamRewardAmounts,
  equalTeamRewardShares,
  type TeamRewardShare,
} from '../settlement/quest-team-reward-allocation';
import { notifyQuestUpdate } from '../v2/realtime';

const hourMs = 60 * 60 * 1000;

/** Rulebook: the Team Leader has 24 hours after the Admin approval to split the money. */
export const teamDisputeSplitWindowMs = 24 * hourMs;

export const teamDisputeSplitOperationScope = 'quest.dispute.team-split';

/** The Wallet cannot pay the whole split now; no member is paid until it can pay all. */
export const disputeFundsUnavailableCode = 'DISPUTE_FUNDS_UNAVAILABLE';

export type TeamDisputeShare = { memberId: string; percentageBasisPoints: number };

export type TeamDisputeAmount = TeamDisputeShare & { amountSatang: number };

/**
 * Split the approved Satang by basis points. The Satang left after rounding down
 * go to the largest fractional remainders, ties to the earlier roster row, so the
 * amounts always add up to the approved total.
 */
export const calculateTeamDisputeAmounts = (
  approvedAmountSatang: number,
  shares: readonly TeamDisputeShare[]
): TeamDisputeAmount[] =>
  calculateTeamRewardAmounts(approvedAmountSatang, 0, shares).map(
    ({ memberId, percentageBasisPoints, rewardSatang }) => ({
      memberId,
      percentageBasisPoints,
      amountSatang: rewardSatang,
    })
  );

type SplitTransaction = WalletTransaction;

const selectedTeamOf = async (transaction: SplitTransaction, questId: string) => {
  const [team] = await transaction
    .select({ id: questCandidateTeamV2.id, leaderId: questCandidateTeamV2.leaderId })
    .from(questCandidateTeamV2)
    .where(
      and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
      )
    )
    .limit(1);
  return team;
};

/** The selected Candidate Team of a Quest, or undefined when the Quest has none. */
export const readSelectedTeam = (transaction: SplitTransaction, questId: string) =>
  selectedTeamOf(transaction, questId);

const rosterOf = async (transaction: SplitTransaction, teamId: string) =>
  (
    await transaction
      .select({ memberId: questCandidateTeamV2Member.memberId })
      .from(questCandidateTeamV2Member)
      .where(eq(questCandidateTeamV2Member.teamId, teamId))
      .orderBy(asc(questCandidateTeamV2Member.joinedAt), asc(questCandidateTeamV2Member.memberId))
  ).map(({ memberId }) => memberId);

const notifySplitUpdated = (transaction: SplitTransaction, questId: string, memberIds: string[]) =>
  notifyQuestUpdate(transaction, {
    questId,
    recipientMemberIds: memberIds,
    changeType: 'DISPUTE_CASE_UPDATED',
  });

/** Satang that other unpaid team approvals of the same Quest already claim from the hold. */
const claimedByOtherApprovals = async (
  transaction: SplitTransaction,
  questId: string,
  exceptDisputeCaseId: string
) => {
  const [row] = await transaction
    .select({
      total: sql<number>`coalesce(sum(${adminDisputeTeamAllocation.approvedAmountSatang}), 0)`,
    })
    .from(adminDisputeTeamAllocation)
    .where(
      and(
        eq(adminDisputeTeamAllocation.questId, questId),
        ne(adminDisputeTeamAllocation.status, 'PAID'),
        ne(adminDisputeTeamAllocation.disputeCaseId, exceptDisputeCaseId)
      )
    );
  return Number(row?.total ?? 0);
};

type OpenInput = {
  disputeCase: Pick<typeof adminDisputeCase.$inferSelect, 'id' | 'questId' | 'teamId'>;
  hirerId: string;
  reservationId: string;
  approvedAmountSatang: number;
  now: Date;
};

/**
 * Record an Admin-approved team amount. The amount must fit what the hold can
 * still pay after other unpaid team approvals. No money moves until the Leader
 * confirms a split.
 */
export const openTeamDisputeSplit = async (
  transaction: SplitTransaction,
  input: OpenInput
): Promise<'opened' | 'exceeds-hold'> => {
  const funds = await readDisputeFundsAvailable(transaction, {
    ownerUserId: input.hirerId,
    reservationId: input.reservationId,
  });
  const claimed = await claimedByOtherApprovals(
    transaction,
    input.disputeCase.questId,
    input.disputeCase.id
  );
  if (input.approvedAmountSatang > funds.capSatang - claimed) return 'exceeds-hold';
  const team = await selectedTeamOf(transaction, input.disputeCase.questId);
  if (!team || team.id !== input.disputeCase.teamId) return 'exceeds-hold';
  await transaction.insert(adminDisputeTeamAllocation).values({
    disputeCaseId: input.disputeCase.id,
    questId: input.disputeCase.questId,
    teamId: team.id,
    leaderId: team.leaderId,
    approvedAmountSatang: input.approvedAmountSatang,
    splitDeadlineAt: new Date(input.now.getTime() + teamDisputeSplitWindowMs),
    createdAt: input.now,
    updatedAt: input.now,
  });
  await notifySplitUpdated(
    transaction,
    input.disputeCase.questId,
    await rosterOf(transaction, team.id)
  );
  return 'opened';
};

const settlementReferenceOf = (allocationId: string, memberId: string) =>
  `dispute-team-split:${allocationId}:${memberId}`;

/**
 * Pay every unpaid member of a confirmed split from the Quest hold, or from the
 * Hirer's Spending Balance after the hold released. The check runs before the
 * first payment, so a short Wallet pays nobody. Each member has one settlement
 * reference, so a retry cannot pay the same member twice.
 */
const payConfirmedSplit = async (
  transaction: SplitTransaction,
  allocation: typeof adminDisputeTeamAllocation.$inferSelect,
  hirerId: string,
  reservationId: string,
  now: Date
) => {
  const unpaid = await transaction
    .select()
    .from(adminDisputeTeamAllocationMember)
    .where(eq(adminDisputeTeamAllocationMember.allocationId, allocation.id))
    .orderBy(asc(adminDisputeTeamAllocationMember.memberId));
  const due = unpaid.filter((row) => row.amountSatang > 0 && row.paidAt === null);
  const dueTotal = due.reduce((sum, row) => sum + row.amountSatang, 0);
  const funds = await readDisputeFundsAvailable(transaction, {
    ownerUserId: hirerId,
    reservationId,
  });
  if (dueTotal > funds.payableSatang) {
    throw new MoneyDomainError(
      'FUNDING_RESERVATION_INSUFFICIENT',
      'The hold and the Hirer Spending Balance cannot pay the whole split.'
    );
  }
  for (const row of due) {
    const settlement = await settleDisputeCase(transaction, {
      ownerUserId: hirerId,
      reservationId,
      settlementReference: settlementReferenceOf(allocation.id, row.memberId),
      recipientUserId: row.memberId,
      requestedAmountSatang: positiveSatang(row.amountSatang),
    });
    if (settlement.recipientAmountSatang !== row.amountSatang) {
      throw new MoneyDomainError(
        'FUNDING_SETTLEMENT_FAILED',
        'A member payment differs from the confirmed split.'
      );
    }
    await transaction
      .update(adminDisputeTeamAllocationMember)
      .set({ ledgerTransactionId: settlement.ledgerTransactionId, paidAt: now })
      .where(
        and(
          eq(adminDisputeTeamAllocationMember.allocationId, allocation.id),
          eq(adminDisputeTeamAllocationMember.memberId, row.memberId)
        )
      );
  }
  await transaction
    .update(adminDisputeTeamAllocation)
    .set({ status: 'PAID', paidAt: now, paymentFailureCode: null, updatedAt: now })
    .where(eq(adminDisputeTeamAllocation.id, allocation.id));
};

/**
 * Try to pay in a savepoint. A Wallet refusal rolls back only that payment and
 * records its code, so the confirmed split stays and a later retry pays it.
 */
const payOrRecordFailure = async (
  transaction: SplitTransaction,
  allocation: typeof adminDisputeTeamAllocation.$inferSelect,
  now: Date
): Promise<boolean> => {
  const [current] = await transaction
    .select({
      hirerId: quest.hirerId,
      reservationId: quest.fundingReservationId,
    })
    .from(quest)
    .where(eq(quest.id, allocation.questId))
    .limit(1);
  try {
    if (!current?.reservationId) {
      throw new MoneyDomainError(
        'FUNDING_RESERVATION_NOT_FOUND',
        'The failed Quest has no Funding Reservation.'
      );
    }
    const { hirerId, reservationId } = current;
    await transaction.transaction((savepoint) =>
      payConfirmedSplit(savepoint, allocation, hirerId, reservationId, now)
    );
    return true;
  } catch (error) {
    if (!(error instanceof MoneyDomainError)) throw error;
    await transaction
      .update(adminDisputeTeamAllocation)
      .set({ paymentFailureCode: error.code, updatedAt: now })
      .where(eq(adminDisputeTeamAllocation.id, allocation.id));
    return false;
  }
};

const confirmSplit = async (
  transaction: SplitTransaction,
  allocation: typeof adminDisputeTeamAllocation.$inferSelect,
  shares: readonly TeamDisputeShare[],
  source: DisputeTeamAllocationSource,
  now: Date
) => {
  const amounts = calculateTeamDisputeAmounts(allocation.approvedAmountSatang, shares);
  await transaction.insert(adminDisputeTeamAllocationMember).values(
    amounts.map((amount) => ({
      allocationId: allocation.id,
      ...amount,
      createdAt: now,
    }))
  );
  const [confirmed] = await transaction
    .update(adminDisputeTeamAllocation)
    .set({ status: 'SPLIT_CONFIRMED', splitSource: source, splitConfirmedAt: now, updatedAt: now })
    .where(eq(adminDisputeTeamAllocation.id, allocation.id))
    .returning();
  if (!confirmed) throw new Error('Team Dispute split confirmation returned no row');
  const paid = await payOrRecordFailure(transaction, confirmed, now);
  await notifySplitUpdated(
    transaction,
    allocation.questId,
    await rosterOf(transaction, allocation.teamId)
  );
  return paid;
};

type SubmitResult = { allocationId: string; status: 'SPLIT_CONFIRMED' | 'PAID' };
type SubmitRejection = 'not-ready' | 'not-leader' | 'deadline-passed' | 'invalid-split';

/** The Leader confirms every member's share; the Server then pays the members. */
export const submitTeamDisputeSplit = async (
  leaderId: string,
  questId: string,
  shares: readonly TeamDisputeShare[],
  idempotencyKey: string,
  now = new Date()
): Promise<QuestCommandResult<SubmitResult, SubmitRejection> | { outcome: 'not-found' }> => {
  const requestHash = await sha256Json({
    memberId: leaderId,
    operation: teamDisputeSplitOperationScope,
    body: { questId, shares },
  });
  return db.transaction(async (transaction) => {
    const [current] = await transaction
      .select({ id: quest.id })
      .from(quest)
      .where(eq(quest.id, questId))
      .limit(1)
      .for('update');
    if (!current) return { outcome: 'not-found' } as const;
    return runQuestCommand<SubmitResult, SubmitRejection>({
      transaction,
      identity: {
        principalUserId: leaderId,
        operationScope: teamDisputeSplitOperationScope,
        key: idempotencyKey,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<QuestCommandWork<SubmitResult, SubmitRejection>> => {
        const [allocation] = await transaction
          .select()
          .from(adminDisputeTeamAllocation)
          .where(eq(adminDisputeTeamAllocation.questId, questId))
          .limit(1)
          .for('update');
        if (!allocation) return { kind: 'rejected', rejection: 'not-ready' };
        if (allocation.leaderId !== leaderId) return { kind: 'rejected', rejection: 'not-leader' };
        if (allocation.status !== 'AWAITING_SPLIT') {
          return { kind: 'rejected', rejection: 'not-ready' };
        }
        if (now.getTime() >= allocation.splitDeadlineAt.getTime()) {
          return { kind: 'rejected', rejection: 'deadline-passed' };
        }
        const roster = await rosterOf(transaction, allocation.teamId);
        const listed = new Set(shares.map(({ memberId }) => memberId));
        const total = shares.reduce((sum, share) => sum + share.percentageBasisPoints, 0);
        if (
          shares.length !== roster.length ||
          listed.size !== roster.length ||
          roster.some((memberId) => !listed.has(memberId)) ||
          shares.some(
            ({ percentageBasisPoints }) =>
              !Number.isInteger(percentageBasisPoints) ||
              percentageBasisPoints < 0 ||
              percentageBasisPoints > 10_000
          ) ||
          total !== 10_000
        ) {
          return { kind: 'rejected', rejection: 'invalid-split' };
        }
        const ordered = roster.map((memberId) =>
          shares.find((share) => share.memberId === memberId)!
        );
        const paid = await confirmSplit(transaction, allocation, ordered, 'LEADER', now);
        return {
          kind: 'success',
          result: { allocationId: allocation.id, status: paid ? 'PAID' : 'SPLIT_CONFIRMED' },
          resourceType: 'dispute-team-split',
          resourceId: allocation.id,
        };
      },
      toSnapshot: (result) => result,
      fromSnapshot: (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
        const value = snapshot as Record<string, unknown>;
        return typeof value.allocationId === 'string' &&
          (value.status === 'PAID' || value.status === 'SPLIT_CONFIRMED')
          ? (value as SubmitResult)
          : undefined;
      },
    });
  });
};

/**
 * Worker step. After the deadline an unsplit approval gets equal shares. A
 * confirmed split that the Wallet could not pay is retried. True when this call
 * left the split paid.
 */
export const settleDueTeamDisputeSplit = async (
  allocationId: string,
  now: Date
): Promise<boolean> =>
  db.transaction(async (transaction) => {
    const [allocation] = await transaction
      .select()
      .from(adminDisputeTeamAllocation)
      .where(eq(adminDisputeTeamAllocation.id, allocationId))
      .limit(1)
      .for('update');
    if (!allocation) return false;
    if (allocation.status === 'SPLIT_CONFIRMED') {
      const paid = await payOrRecordFailure(transaction, allocation, now);
      if (paid) {
        await notifySplitUpdated(
          transaction,
          allocation.questId,
          await rosterOf(transaction, allocation.teamId)
        );
      }
      return paid;
    }
    if (
      allocation.status !== 'AWAITING_SPLIT' ||
      now.getTime() < allocation.splitDeadlineAt.getTime()
    ) {
      return false;
    }
    const roster = await rosterOf(transaction, allocation.teamId);
    const shares: TeamRewardShare[] = equalTeamRewardShares(roster);
    return confirmSplit(transaction, allocation, shares, 'AUTO_EQUAL', now);
  });

export type TeamDisputeSplitView = {
  disputeCaseId: string;
  status: DisputeTeamAllocationStatus;
  splitSource: DisputeTeamAllocationSource | null;
  approvedAmountSatang: number;
  deadlineAt: Date;
  confirmedAt: Date | null;
  paidAt: Date | null;
  /** True while a confirmed split waits for the Wallet; the Server retries it. */
  paymentPending: boolean;
  viewerIsLeader: boolean;
  canSubmitSplit: boolean;
  members: Array<{
    memberId: string;
    displayName: string;
    isLeader: boolean;
    percentageBasisPoints: number | null;
    amountSatang: number | null;
    paidAt: Date | null;
  }>;
};

export type TeamDisputeSplitOutcome =
  { outcome: 'not-found' | 'not-authorized' | 'not-ready' } | TeamDisputeSplitView;

/** The split state for a Team member: the roster, the shares, and who may confirm. */
export const readTeamDisputeSplit = async (
  viewerId: string,
  questId: string,
  now = new Date()
): Promise<TeamDisputeSplitOutcome> => {
  const [current] = await db.select({ id: quest.id }).from(quest).where(eq(quest.id, questId));
  if (!current) return { outcome: 'not-found' };
  const [allocation] = await db
    .select()
    .from(adminDisputeTeamAllocation)
    .where(eq(adminDisputeTeamAllocation.questId, questId))
    .limit(1);
  if (!allocation) return { outcome: 'not-ready' };
  const roster = await db.transaction((transaction) => rosterOf(transaction, allocation.teamId));
  if (!roster.includes(viewerId)) return { outcome: 'not-authorized' };
  const saved = await db
    .select()
    .from(adminDisputeTeamAllocationMember)
    .where(eq(adminDisputeTeamAllocationMember.allocationId, allocation.id));
  const byMember = new Map(saved.map((row) => [row.memberId, row]));
  const summaries = await loadMemberSummaries(roster);
  return {
    disputeCaseId: allocation.disputeCaseId,
    status: allocation.status,
    splitSource: allocation.splitSource,
    approvedAmountSatang: allocation.approvedAmountSatang,
    deadlineAt: allocation.splitDeadlineAt,
    confirmedAt: allocation.splitConfirmedAt,
    paidAt: allocation.paidAt,
    paymentPending: allocation.status === 'SPLIT_CONFIRMED',
    viewerIsLeader: viewerId === allocation.leaderId,
    canSubmitSplit:
      viewerId === allocation.leaderId &&
      allocation.status === 'AWAITING_SPLIT' &&
      now.getTime() < allocation.splitDeadlineAt.getTime(),
    members: roster.map((memberId) => ({
      memberId,
      displayName: summaries(memberId).displayName,
      isLeader: memberId === allocation.leaderId,
      percentageBasisPoints: byMember.get(memberId)?.percentageBasisPoints ?? null,
      amountSatang: byMember.get(memberId)?.amountSatang ?? null,
      paidAt: byMember.get(memberId)?.paidAt ?? null,
    })),
  };
};

/** Worker query: allocations that wait for an automatic split or a payment retry. */
export const dueTeamDisputeSplitIds = (now: Date, limit: number) =>
  db
    .select({ id: adminDisputeTeamAllocation.id, questId: adminDisputeTeamAllocation.questId })
    .from(adminDisputeTeamAllocation)
    .where(
      sql`(${adminDisputeTeamAllocation.status} = 'SPLIT_CONFIRMED'
        OR (${adminDisputeTeamAllocation.status} = 'AWAITING_SPLIT'
          AND ${adminDisputeTeamAllocation.splitDeadlineAt} <= ${now.toISOString()}::timestamptz))`
    )
    .orderBy(asc(adminDisputeTeamAllocation.splitDeadlineAt), asc(adminDisputeTeamAllocation.id))
    .limit(limit);

export const serializeTeamDisputeSplit = (view: TeamDisputeSplitView) => ({
  ...view,
  deadlineAt: view.deadlineAt.toISOString(),
  confirmedAt: view.confirmedAt?.toISOString() ?? null,
  paidAt: view.paidAt?.toISOString() ?? null,
  members: view.members.map((member) => ({
    ...member,
    paidAt: member.paidAt?.toISOString() ?? null,
  })),
});
