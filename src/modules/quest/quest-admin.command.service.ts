import { quest } from '@/database/schema/quest.schema';
import {
  createAdminActionService,
  type AdminActionCommandResult,
  type AdminActionReasonCatalog,
} from '@/modules/admin';

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import {
  getAdminQuestSummaryInTransaction,
  serializeAdminQuestSummary,
} from './quest-admin.service';
import type { AdminQuestSummaryResponse } from './quest-admin.service';
import { terminateQuestInTransaction } from './quest-settlement.service';
import type { QuestTransaction } from './quest-assignment.service';
import { isTerminalQuestStatus, questStatus } from './quest.contract';

export const questAdminReasonCodes = ['POLICY_REVIEW', 'SAFETY_REVIEW'] as const;

export const questAdminActionCatalog: AdminActionReasonCatalog = {
  version: 1,
  actions: {
    QUEST_HIDE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: questAdminReasonCodes,
    },
    QUEST_RESTORE: {
      kind: 'COMMAND',
      requiresReason: false,
      allowedReasonCodes: questAdminReasonCodes,
    },
    QUEST_TERMINATE: {
      kind: 'COMMAND',
      requiresReason: true,
      allowedReasonCodes: questAdminReasonCodes,
    },
  },
};

const adminActionService = createAdminActionService(questAdminActionCatalog);

export type QuestAdminCommandErrorCode =
  | 'QUEST_NOT_FOUND'
  | 'QUEST_ACTION_NOT_ALLOWED'
  | 'QUEST_RESTORE_NOT_ELIGIBLE';

export class QuestAdminCommandError extends Error {
  readonly code: QuestAdminCommandErrorCode;

  constructor(code: QuestAdminCommandErrorCode, message: string) {
    super(message);
    this.name = 'QuestAdminCommandError';
    this.code = code;
  }
}

export type QuestAdminCommandInput = {
  adminId: string;
  questId: string;
  expectedVersion: number;
  requestKey: string;
  reasonCode?: string;
  now?: Date;
};

export type QuestAdminCommandResult = AdminActionCommandResult<AdminQuestSummaryResponse>;

type QuestAdminCommandAction = 'QUEST_HIDE' | 'QUEST_RESTORE' | 'QUEST_TERMINATE';

const summaryResult = async (
  transaction: QuestTransaction,
  questId: string,
): Promise<{
  resourceSummary: AdminQuestSummaryResponse;
  resourceVersion: number;
  resourceTimestamp: null;
}> => {
  const summary = await getAdminQuestSummaryInTransaction(transaction, questId);
  if (!summary) throw new QuestAdminCommandError('QUEST_NOT_FOUND', 'Quest not found');
  return {
    resourceSummary: serializeAdminQuestSummary(summary),
    resourceVersion: summary.version,
    resourceTimestamp: null,
  };
};

const executeQuestAdminCommand = async (
  action: QuestAdminCommandAction,
  input: QuestAdminCommandInput,
): Promise<QuestAdminCommandResult> => {
  const now = input.now ?? new Date();
  return adminActionService.executeCommand({
    adminId: input.adminId,
    action,
    resourceType: 'quest',
    resourceId: input.questId,
    requestKey: input.requestKey,
    reasonCode: input.reasonCode,
    request: {},
    metadata: {},
    expectedVersion: input.expectedVersion,
    prepare: async (transaction, context) => {
      const [current] = await transaction.select({
        id: quest.id,
        questStatus: quest.questStatus,
        version: quest.version,
        hiddenAt: quest.hiddenAt,
        hiddenByAdminId: quest.hiddenByAdminId,
        startTime: quest.startTime,
        dueAt: quest.dueAt,
      }).from(quest).where(eq(quest.id, input.questId)).limit(1).for('update');
      if (!current) throw new QuestAdminCommandError('QUEST_NOT_FOUND', 'Quest not found');

      return {
        currentVersion: current.version,
        apply: async () => {
          if (action === 'QUEST_HIDE') {
            if (isTerminalQuestStatus(current.questStatus) || current.hiddenAt !== null) {
              throw new QuestAdminCommandError('QUEST_ACTION_NOT_ALLOWED', 'Quest cannot be hidden in its current state.');
            }
            await transaction.update(quest).set({
              hiddenAt: now,
              hiddenByAdminId: input.adminId,
              version: sql`${quest.version} + 1`,
              updatedAt: now,
            }).where(and(
              eq(quest.id, input.questId),
              eq(quest.version, input.expectedVersion),
              isNull(quest.hiddenAt),
            ));
            return summaryResult(transaction, input.questId);
          }

          if (action === 'QUEST_RESTORE') {
            if (
              current.questStatus !== questStatus.open ||
              current.hiddenAt === null ||
              current.hiddenByAdminId === null
            ) {
              throw new QuestAdminCommandError('QUEST_ACTION_NOT_ALLOWED', 'Quest cannot be restored in its current state.');
            }
            if (current.startTime <= now || (current.dueAt !== null && current.dueAt <= now)) {
              throw new QuestAdminCommandError('QUEST_RESTORE_NOT_ELIGIBLE', 'Quest cannot be restored after its start or due time.');
            }
            await transaction.update(quest).set({
              hiddenAt: null,
              hiddenByAdminId: null,
              version: sql`${quest.version} + 1`,
              updatedAt: now,
            }).where(and(
              eq(quest.id, input.questId),
              eq(quest.version, input.expectedVersion),
              isNotNull(quest.hiddenAt),
            ));
            return summaryResult(transaction, input.questId);
          }

          const result = await terminateQuestInTransaction(
            transaction,
            input.questId,
            input.adminId,
            context.requestKey,
            now,
          );
          if (result.outcome === 'not-found') {
            throw new QuestAdminCommandError('QUEST_NOT_FOUND', 'Quest not found');
          }
          if (result.outcome !== 'CANCELLED') {
            throw new QuestAdminCommandError('QUEST_ACTION_NOT_ALLOWED', 'Quest cannot be terminated in its current state.');
          }
          return summaryResult(transaction, input.questId);
        },
      };
    },
  });
};

export const hideQuest = (input: QuestAdminCommandInput) => executeQuestAdminCommand('QUEST_HIDE', input);

export const restoreQuest = (input: QuestAdminCommandInput) => executeQuestAdminCommand('QUEST_RESTORE', input);

export const terminateQuest = (input: QuestAdminCommandInput) => executeQuestAdminCommand('QUEST_TERMINATE', input);
