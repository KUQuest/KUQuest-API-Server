import { db } from '@/database/client';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questTeam,
} from '@/database/schema/quest.schema';
import { notifyQuestUpdate } from '@/modules/quest/v2/realtime';

import { and, eq } from 'drizzle-orm';

import {
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './command/quest-command.service';
import { applyQuestStateTransition } from './transition/quest-transition.service';
import { questMode, questParticipation } from './contracts/quest.contract';
import { questV2Mode, questV2Participation } from '../v2/core/quest-v2.contract';

export const questV2StartWorkOperationScope = 'quest.v2.start-work';
export const questV1StartWorkOperationScope = 'quest.v1.start-work';

type QuestApiVersion = 'v1' | 'v2';

export type QuestStartWork = {
  questId: string;
  assignmentId: string;
  startedAt: Date;
  questStatus: 'QUEST_ASSIGNED' | 'QUEST_IN_PROGRESS';
};

type StartWorkRejection =
  | 'not-found'
  | 'not-assigned'
  | 'not-authorized'
  | 'not-required-starter'
  | 'start-window-not-open'
  | 'start-window-closed'
  | 'already-started'
  | 'not-contract';

export type QuestStartWorkOutcome =
  QuestStartWork | { outcome: StartWorkRejection | QuestCommandOutcomeCode };

const resultFromSnapshot = (snapshot: unknown): QuestStartWork | undefined => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return undefined;
  const value = snapshot as Record<string, unknown>;
  if (
    typeof value.questId !== 'string' ||
    typeof value.assignmentId !== 'string' ||
    typeof value.startedAt !== 'string' ||
    (value.questStatus !== 'QUEST_ASSIGNED' && value.questStatus !== 'QUEST_IN_PROGRESS')
  ) {
    return undefined;
  }
  const startedAt = new Date(value.startedAt);
  if (Number.isNaN(startedAt.getTime())) return undefined;
  return {
    questId: value.questId,
    assignmentId: value.assignmentId,
    startedAt,
    questStatus: value.questStatus,
  };
};

export const startQuestWork = async (
  apiVersion: QuestApiVersion,
  workerId: string,
  questId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestStartWorkOutcome> => {
  const requestHash = await sha256Json({ action: 'start-work', apiVersion, questId, workerId });
  return db.transaction(async (transaction) => {
    // Lock the Quest before recording its command to preserve Quest Command lock order.
    const [current] = await transaction
      .select({
        hirerId: quest.hirerId,
        questStatus: quest.questStatus,
        mode: quest.mode,
        participation: quest.participation,
        v2Mode: quest.v2Mode,
        v2Participation: quest.v2Participation,
        startTime: quest.startTime,
        dueAt: quest.dueAt,
      })
      .from(quest)
      .where(and(eq(quest.id, questId), eq(quest.apiVersion, apiVersion)))
      .limit(1)
      .for('update');
    if (!current) return { outcome: 'not-found' };

    const operationScope =
      apiVersion === 'v2' ? questV2StartWorkOperationScope : questV1StartWorkOperationScope;
    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: workerId,
        operationScope,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<QuestCommandWork<QuestStartWork, StartWorkRejection>> => {
        const candidateGroup =
          apiVersion === 'v2'
            ? current.v2Mode === questV2Mode.candidate &&
              current.v2Participation === questV2Participation.group
            : current.mode === questMode.candidate &&
              current.participation === questParticipation.group;
        const validModeAndParticipation =
          apiVersion === 'v2'
            ? (current.v2Mode === questV2Mode.firstComeFirstServed ||
                current.v2Mode === questV2Mode.candidate) &&
              (current.v2Participation === questV2Participation.single ||
                current.v2Participation === questV2Participation.group)
            : (current.mode === questMode.noCandidate || current.mode === questMode.candidate) &&
              (current.participation === questParticipation.solo ||
                current.participation === questParticipation.group);
        if (!validModeAndParticipation || !current.dueAt) {
          return { kind: 'rejected', rejection: 'not-contract' };
        }
        if (current.questStatus !== 'QUEST_ASSIGNED') {
          return { kind: 'rejected', rejection: 'not-assigned' };
        }
        if (now < current.startTime) {
          return { kind: 'rejected', rejection: 'start-window-not-open' };
        }
        if (now > current.dueAt) {
          return { kind: 'rejected', rejection: 'start-window-closed' };
        }

        const assignments = await transaction
          .select({
            id: questAssignment.id,
            workerId: questAssignment.workerId,
            startedAt: questAssignment.startedAt,
          })
          .from(questAssignment)
          .where(
            and(
              eq(questAssignment.questId, questId),
              eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
            )
          )
          .for('update');
        const assignment = assignments.find(
          ({ workerId: assignedWorkerId }) => assignedWorkerId === workerId
        );
        if (!assignment) return { kind: 'rejected', rejection: 'not-authorized' };

        if (candidateGroup) {
          const leaderId =
            apiVersion === 'v2'
              ? (
                  await transaction
                    .select({ leaderId: questCandidateTeamV2.leaderId })
                    .from(questCandidateTeamV2)
                    .where(
                      and(
                        eq(questCandidateTeamV2.questId, questId),
                        eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
                      )
                    )
                    .limit(1)
                    .for('update')
                )[0]?.leaderId
              : (
                  await transaction
                    .select({ leaderId: questTeam.leaderId })
                    .from(questTeam)
                    .where(
                      and(eq(questTeam.questId, questId), eq(questTeam.teamStatus, 'TEAM_SELECTED'))
                    )
                    .limit(1)
                    .for('update')
                )[0]?.leaderId;
          if (!leaderId) return { kind: 'rejected', rejection: 'not-contract' };
          if (leaderId !== workerId) {
            return { kind: 'rejected', rejection: 'not-required-starter' };
          }
        }
        if (assignment.startedAt) return { kind: 'rejected', rejection: 'already-started' };

        const [startedAssignment] = await transaction
          .update(questAssignment)
          .set({ startedAt: now })
          .where(
            and(
              eq(questAssignment.id, assignment.id),
              eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
            )
          )
          .returning({ id: questAssignment.id, startedAt: questAssignment.startedAt });
        if (!startedAssignment?.startedAt) return { kind: 'rejected', rejection: 'not-authorized' };

        const allRequiredStarted =
          candidateGroup ||
          (apiVersion === 'v2'
            ? current.v2Participation !== questV2Participation.group
            : current.participation !== questParticipation.group) ||
          assignments.every(({ id, startedAt }) => id === assignment.id || startedAt !== null);
        let questStatus: QuestStartWork['questStatus'] = 'QUEST_ASSIGNED';
        if (allRequiredStarted) {
          const transitioned = await applyQuestStateTransition(transaction, {
            questId,
            from: 'QUEST_ASSIGNED',
            to: 'QUEST_IN_PROGRESS',
            now,
            workChat: [],
          });
          if (!transitioned) return { kind: 'rejected', rejection: 'not-assigned' };
          questStatus = 'QUEST_IN_PROGRESS';
          if (apiVersion === 'v2') {
            await notifyQuestUpdate(transaction, {
              questId,
              recipientMemberIds: [
                ...new Set([current.hirerId, ...assignments.map(({ workerId }) => workerId)]),
              ],
              changeType: 'QUEST_STARTED',
            });
          }
        }

        return {
          kind: 'success',
          result: {
            questId,
            assignmentId: startedAssignment.id,
            startedAt: startedAssignment.startedAt,
            questStatus,
          },
          resourceType: 'QUEST_ASSIGNMENT',
          resourceId: startedAssignment.id,
        };
      },
      toSnapshot: (result) => ({ ...result, startedAt: result.startedAt.toISOString() }),
      fromSnapshot: resultFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    return command.kind === 'success' ? command.result : { outcome: command.rejection };
  });
};
