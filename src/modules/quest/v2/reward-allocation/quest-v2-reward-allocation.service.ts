import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questCandidateTeamV2Member,
  questV2TeamRewardAllocation,
  questV2TeamRewardAllocationMember,
} from '@/database/schema/quest.schema';
import { loadMemberSummaries } from '@/modules/quest/shared/member-summary';
import {
  runQuestCommand,
  sha256Json,
  type QuestCommandResult,
  type QuestCommandWork,
} from '@/modules/quest/shared/command/quest-command.service';
import { settleV2TeamRewardAllocationInTransaction } from '@/modules/quest/settlement';

import { and, asc, eq } from 'drizzle-orm';

import type { QuestV2RewardAllocationRequest } from './quest-v2-reward-allocation.schema';

type AllocationStatus = 'PENDING' | 'SUBMITTED' | 'AUTO_EQUAL';
type AllocationMember = {
  memberId: string;
  displayName: string;
  isLeader: boolean;
  percentageBasisPoints: number | null;
  rewardSatang: number | null;
};

export type QuestV2RewardAllocation = {
  status: AllocationStatus;
  leaderId: string;
  totalRewardSatang: number;
  deadlineAt: Date;
  settledAt: Date | null;
  viewerIsLeader: boolean;
  members: AllocationMember[];
};

export type QuestV2RewardAllocationOutcome =
  | {
      outcome:
        | 'not-found'
        | 'not-authorized'
        | 'not-ready'
        | 'not-leader'
        | 'deadline-passed'
        | 'invalid-allocation';
    }
  | QuestV2RewardAllocation;

export const questV2RewardAllocationOperationScope = 'quest.v2.team-reward-allocation';

export const getQuestV2RewardAllocation = async (
  memberId: string,
  questId: string
): Promise<QuestV2RewardAllocationOutcome> => {
  const [current] = await db
    .select({ state: quest.questStatus, mode: quest.v2Mode, participation: quest.v2Participation })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!current) return { outcome: 'not-found' };
  if (
    current.mode !== 'CANDIDATE' ||
    current.participation !== 'GROUP' ||
    current.state !== 'QUEST_COMPLETED'
  ) {
    return { outcome: 'not-ready' };
  }
  const [allocation] = await db
    .select()
    .from(questV2TeamRewardAllocation)
    .where(eq(questV2TeamRewardAllocation.questId, questId))
    .limit(1);
  if (!allocation) return { outcome: 'not-ready' };
  const memberships = await db
    .select({ memberId: questCandidateTeamV2Member.memberId })
    .from(questCandidateTeamV2Member)
    .where(eq(questCandidateTeamV2Member.teamId, allocation.teamId))
    .orderBy(asc(questCandidateTeamV2Member.joinedAt), asc(questCandidateTeamV2Member.memberId));
  if (!memberships.some(({ memberId: id }) => id === memberId)) {
    return { outcome: 'not-authorized' };
  }
  const memberIds = memberships.map(({ memberId: id }) => id);
  const summaries = await loadMemberSummaries(memberIds);
  const savedMembers = await db
    .select({
      memberId: questV2TeamRewardAllocationMember.memberId,
      percentageBasisPoints: questV2TeamRewardAllocationMember.percentageBasisPoints,
      rewardSatang: questV2TeamRewardAllocationMember.rewardSatang,
    })
    .from(questV2TeamRewardAllocationMember)
    .where(eq(questV2TeamRewardAllocationMember.allocationId, allocation.id));
  const byMember = new Map(savedMembers.map((row) => [row.memberId, row]));
  return {
    status: allocation.status,
    leaderId: allocation.leaderId,
    totalRewardSatang: allocation.totalRewardSatang,
    deadlineAt: allocation.deadlineAt,
    settledAt: allocation.settledAt,
    viewerIsLeader: memberId === allocation.leaderId,
    members: memberIds.map((id) => ({
      memberId: id,
      displayName: summaries(id).displayName,
      isLeader: id === allocation.leaderId,
      percentageBasisPoints: byMember.get(id)?.percentageBasisPoints ?? null,
      rewardSatang: byMember.get(id)?.rewardSatang ?? null,
    })),
  };
};

type SubmitResult = { allocationId: string; status: 'SUBMITTED'; settledAt: string };
type SubmitRejection =
  'not-found' | 'not-ready' | 'not-leader' | 'deadline-passed' | 'invalid-allocation';

export const submitQuestV2RewardAllocation = async (
  memberId: string,
  questId: string,
  input: QuestV2RewardAllocationRequest,
  idempotencyKey: string,
  now = new Date()
): Promise<QuestCommandResult<SubmitResult, SubmitRejection> | { outcome: 'not-found' }> => {
  const requestHash = await sha256Json({
    memberId,
    operation: questV2RewardAllocationOperationScope,
    path: '/api/v2/quests/:questId/reward-allocation',
    body: { questId, teammateShares: input.teammateShares },
  });
  return db.transaction(async (transaction) => {
    const [current] = await transaction
      .select({ id: quest.id, apiVersion: quest.apiVersion })
      .from(quest)
      .where(eq(quest.id, questId))
      .limit(1)
      .for('update');
    if (!current || current.apiVersion !== questApiVersion.v2) return { outcome: 'not-found' };
    const command = await runQuestCommand<SubmitResult, SubmitRejection>({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2RewardAllocationOperationScope,
        key: idempotencyKey,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<QuestCommandWork<SubmitResult, SubmitRejection>> => {
        const [allocation] = await transaction
          .select({
            id: questV2TeamRewardAllocation.id,
            leaderId: questV2TeamRewardAllocation.leaderId,
          })
          .from(questV2TeamRewardAllocation)
          .where(eq(questV2TeamRewardAllocation.questId, questId))
          .limit(1)
          .for('update');
        if (!allocation) return { kind: 'rejected', rejection: 'not-ready' };
        if (allocation.leaderId !== memberId) return { kind: 'rejected', rejection: 'not-leader' };
        const settled = await settleV2TeamRewardAllocationInTransaction(
          transaction,
          questId,
          now,
          'SUBMITTED',
          input.teammateShares
        );
        if ('outcome' in settled) {
          return { kind: 'rejected', rejection: settled.outcome as SubmitRejection };
        }
        if (settled.status !== 'SUBMITTED') {
          return { kind: 'rejected', rejection: 'invalid-allocation' };
        }
        return {
          kind: 'success',
          result: {
            allocationId: settled.allocationId,
            status: settled.status,
            settledAt: settled.settledAt.toISOString(),
          },
          resourceType: 'quest-v2-team-reward-allocation',
          resourceId: settled.allocationId,
        };
      },
      toSnapshot: (result) => result,
      fromSnapshot: (snapshot) => {
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
        const value = snapshot as Record<string, unknown>;
        return typeof value.allocationId === 'string' &&
          value.status === 'SUBMITTED' &&
          typeof value.settledAt === 'string'
          ? (value as SubmitResult)
          : undefined;
      },
    });
    return command;
  });
};

export const settleDueQuestV2RewardAllocation = async (questId: string, now: Date) =>
  db.transaction((transaction) =>
    settleV2TeamRewardAllocationInTransaction(transaction, questId, now, 'AUTO_EQUAL')
  );
