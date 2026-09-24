import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questAssignment,
  questCandidateApplicationV2,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import type { QuestTransaction } from '@/modules/quest/shared';

import { and, eq, isNotNull, lte, ne, or } from 'drizzle-orm';

import {
  isReadableCandidateApplicationRoster,
  isReadableCandidateTeamRoster,
  type CandidateRosterQuestAccessState,
} from '../shared/candidate-roster-access.policy';
import type { CandidateRosterScope, QuestUpdateAccess } from './quest-update.schema';

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

export const getCandidateRosterAccess = async (
  memberId: string,
  questId: string
): Promise<CandidateRosterScope | undefined> => {
  const [current] = await db
    .select({
      apiVersion: quest.apiVersion,
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!current || current.apiVersion !== questApiVersion.v2) return undefined;

  const state: CandidateRosterQuestAccessState = {
    v2Mode: current.v2Mode,
    v2Participation: current.v2Participation,
    questState: current.questState,
  };
  const canReadApplications = isReadableCandidateApplicationRoster(state);
  const canReadTeams = isReadableCandidateTeamRoster(state);
  if (!canReadApplications && !canReadTeams) return undefined;
  if (current.hirerId === memberId) return { kind: 'HIRER' };

  if (canReadApplications) {
    const [application] = await db
      .select({ id: questCandidateApplicationV2.id })
      .from(questCandidateApplicationV2)
      .where(
        and(
          eq(questCandidateApplicationV2.questId, questId),
          eq(questCandidateApplicationV2.memberId, memberId)
        )
      )
      .limit(1);
    return application ? { kind: 'APPLICATION', applicationId: application.id } : undefined;
  }

  const [membership] = await db
    .select({ teamId: questCandidateTeamV2Member.teamId })
    .from(questCandidateTeamV2Member)
    .innerJoin(questCandidateTeamV2, eq(questCandidateTeamV2Member.teamId, questCandidateTeamV2.id))
    .where(
      and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2Member.memberId, memberId),
        ne(questCandidateTeamV2.state, 'TEAM_DISBANDED')
      )
    )
    .limit(1);
  return membership ? { kind: 'TEAM', teamId: membership.teamId } : undefined;
};
