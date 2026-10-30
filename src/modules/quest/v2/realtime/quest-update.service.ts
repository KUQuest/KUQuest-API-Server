import { db } from '@/database/client';
import { authSession } from '@/database/schema/auth.schema';
import { chatConversation } from '@/database/schema/work-chat.schema';
import {
  quest,
  questApiVersion,
  questAssignment,
  questCandidateApplicationV2,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2TeamRewardAllocation,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import {
  assignmentStatus,
  assignmentStatuses,
  isMoneyHoldOpen,
  moneyHoldDurationMs,
  questStatus,
  type AssignmentStatus,
  type QuestStatus,
  type QuestTransaction,
} from '@/modules/quest/shared';

import { and, eq, gt, isNotNull, lte, ne, or } from 'drizzle-orm';

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

type QuestUpdateAccessFacts = {
  memberId: string;
  questId: string;
  isHirer: boolean;
  questState: QuestStatus;
  assignment: string | undefined;
  moneyHold: 'NONE' | 'HELD' | 'ENDED';
  dueAt: Date | null;
};

type QuestUpdateAccessRule = Omit<QuestUpdateAccess, 'accessEndsAt'> & {
  questStates: readonly QuestStatus[];
  assignments?: readonly AssignmentStatus[];
  moneyHolds?: readonly QuestUpdateAccessFacts['moneyHold'][];
  closesAtMoneyHoldEnd?: true;
  check?: (facts: QuestUpdateAccessFacts) => Promise<boolean>;
};

const holdsTeamRewardAllocation = async ({ memberId, questId }: QuestUpdateAccessFacts) => {
  const [allocation] = await db
    .select({ id: questV2TeamRewardAllocation.id })
    .from(questV2TeamRewardAllocation)
    .innerJoin(
      questCandidateTeamV2Member,
      eq(questCandidateTeamV2Member.teamId, questV2TeamRewardAllocation.teamId)
    )
    .where(
      and(
        eq(questV2TeamRewardAllocation.questId, questId),
        eq(questCandidateTeamV2Member.memberId, memberId)
      )
    )
    .limit(1);
  return allocation !== undefined;
};

const hasOpenCandidateInquiry = async ({ memberId, questId }: QuestUpdateAccessFacts) => {
  const [inquiry] = await db
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(
      and(
        eq(chatConversation.questId, questId),
        eq(chatConversation.candidateWorkerId, memberId),
        eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
        eq(chatConversation.state, 'INQUIRY_OPEN')
      )
    )
    .limit(1);
  return inquiry !== undefined;
};

const hasOnTimePendingProof = async ({ memberId, questId, dueAt }: QuestUpdateAccessFacts) => {
  if (dueAt === null) return false;
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
        lte(questV2ProofSubmission.sentAt, dueAt),
        or(
          eq(questV2ProofSubmission.workerId, memberId),
          eq(questCandidateTeamV2Member.memberId, memberId)
        )
      )
    )
    .limit(1);
  return pendingProof !== undefined;
};

const questUpdateAccessPolicy: readonly QuestUpdateAccessRule[] = [
  {
    role: 'HIRER',
    mode: 'LIVE',
    questStates: [
      questStatus.open,
      questStatus.assigned,
      questStatus.inProgress,
      questStatus.completed,
      questStatus.failed,
      questStatus.cancelled,
    ],
  },
  {
    role: 'WORKER',
    mode: 'LIVE',
    questStates: [questStatus.open, questStatus.assigned, questStatus.inProgress],
    assignments: [assignmentStatus.active],
  },
  {
    role: 'WORKER',
    mode: 'LIVE',
    questStates: [questStatus.completed],
    assignments: [assignmentStatus.completed],
    check: holdsTeamRewardAllocation,
  },
  {
    role: 'WORKER',
    mode: 'LIVE',
    questStates: [questStatus.completed],
    assignments: [assignmentStatus.incomplete],
    moneyHolds: ['HELD'],
    closesAtMoneyHoldEnd: true,
  },
  {
    role: 'PROSPECTIVE_WORKER',
    mode: 'LIVE',
    questStates: [questStatus.open],
    check: hasOpenCandidateInquiry,
  },
  {
    role: 'WORKER',
    mode: 'PENDING_PROOF',
    questStates: [questStatus.completed, questStatus.failed],
    assignments: assignmentStatuses,
    moneyHolds: ['HELD', 'ENDED'],
    check: hasOnTimePendingProof,
  },
];

const ruleMatches = async (rule: QuestUpdateAccessRule, facts: QuestUpdateAccessFacts) =>
  (rule.role === 'HIRER') === facts.isHirer &&
  rule.questStates.includes(facts.questState) &&
  (rule.assignments?.some((status) => status === facts.assignment) ?? true) &&
  (rule.moneyHolds?.includes(facts.moneyHold) ?? true) &&
  (rule.check === undefined || (await rule.check(facts)));

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
      moneyHoldStartedAt: quest.moneyHoldStartedAt,
    })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!current || current.apiVersion !== questApiVersion.v2) return undefined;

  const isHirer = current.hirerId === memberId;
  const [assignment] = isHirer
    ? []
    : await db
        .select({ status: questAssignment.assignmentStatus })
        .from(questAssignment)
        .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, memberId)))
        .limit(1);
  const moneyHoldEndsAt = isMoneyHoldOpen(current)
    ? new Date(current.moneyHoldStartedAt.getTime() + moneyHoldDurationMs)
    : undefined;
  const facts: QuestUpdateAccessFacts = {
    memberId,
    questId,
    isHirer,
    questState: current.state,
    assignment: assignment?.status,
    moneyHold:
      moneyHoldEndsAt === undefined ? 'NONE' : moneyHoldEndsAt > new Date() ? 'HELD' : 'ENDED',
    dueAt: current.dueAt,
  };

  for (const rule of questUpdateAccessPolicy) {
    if (!(await ruleMatches(rule, facts))) continue;
    return {
      role: rule.role,
      mode: rule.mode,
      ...(rule.closesAtMoneyHoldEnd ? { accessEndsAt: moneyHoldEndsAt } : {}),
    };
  }
  return undefined;
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

export const getQuestBoardUpdateAccess = async (memberId: string, sessionId: string) => {
  const [session] = await db
    .select({ id: authSession.id })
    .from(authSession)
    .where(
      and(
        eq(authSession.id, sessionId),
        eq(authSession.userId, memberId),
        gt(authSession.expiresAt, new Date())
      )
    )
    .limit(1);
  return session?.id;
};
