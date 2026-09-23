import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questAssignment,
  questCandidateTeamV2Member,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import type { QuestTransaction } from '@/modules/quest/shared';

import { and, eq, isNotNull, lte, or } from 'drizzle-orm';

import type { QuestUpdateAccess } from './quest-update.schema';

export const getQuestUpdateRoster = async (transaction: QuestTransaction, questId: string) => {
  const [current] = await transaction
    .select({ apiVersion: quest.apiVersion, hirerId: quest.hirerId })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!current || current.apiVersion !== questApiVersion.v2) return undefined;

  const assignments = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    );
  return { hirerId: current.hirerId, workerIds: assignments.map(({ workerId }) => workerId) };
};

export const getQuestUpdateAccess = async (
  memberId: string,
  questId: string
): Promise<QuestUpdateAccess | undefined> => {
  const [current] = await db
    .select({
      apiVersion: quest.apiVersion,
      hirerId: quest.hirerId,
      state: quest.questStatus,
      dueAt: quest.dueAt,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);

  if (!current || current.apiVersion !== questApiVersion.v2) return undefined;

  // The only QUEST_OPEN subscribers are the Hirer and Members with active Assignments.
  if (current.hirerId === memberId) {
    if (
      current.state === 'QUEST_OPEN' ||
      current.state === 'QUEST_ASSIGNED' ||
      current.state === 'QUEST_IN_PROGRESS' ||
      current.state === 'QUEST_COMPLETED' ||
      current.state === 'QUEST_FAILED' ||
      current.state === 'QUEST_CANCELLED'
    ) {
      return { role: 'HIRER', mode: 'LIVE' };
    }
    return undefined;
  }

  const [assignment] = await db
    .select({ status: questAssignment.assignmentStatus })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, memberId)))
    .limit(1);
  if (!assignment) return undefined;
  if (
    assignment.status === 'ASSIGNMENT_ACTIVE' &&
    (current.state === 'QUEST_OPEN' ||
      current.state === 'QUEST_ASSIGNED' ||
      current.state === 'QUEST_IN_PROGRESS')
  ) {
    return { role: 'WORKER', mode: 'LIVE' };
  }

  if (current.state !== 'QUEST_FAILED' || current.dueAt === null) return undefined;
  const [pendingProof] = await db
    .select({ id: questV2ProofSubmission.id })
    .from(questV2ProofSubmission)
    .leftJoin(
      questCandidateTeamV2Member,
      eq(questCandidateTeamV2Member.teamId, questV2ProofSubmission.teamId)
    )
    .where(
      and(
        eq(questV2ProofSubmission.questId, questId),
        eq(questV2ProofSubmission.submissionStatus, 'PROOF_PENDING'),
        isNotNull(questV2ProofSubmission.sentAt),
        lte(questV2ProofSubmission.sentAt, current.dueAt),
        or(
          eq(questV2ProofSubmission.workerId, memberId),
          eq(questCandidateTeamV2Member.memberId, memberId)
        )
      )
    )
    .limit(1);

  return pendingProof ? { role: 'WORKER', mode: 'PENDING_PROOF' } : undefined;
};
