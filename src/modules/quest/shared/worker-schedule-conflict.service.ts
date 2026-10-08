import { authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment } from '@/database/schema/quest.schema';

import { and, asc, eq, gt, inArray, lt, ne } from 'drizzle-orm';

import type { QuestTransaction } from './work-chat/quest-work-chat.port';

export const hasOverlappingActiveWorkerAssignment = async (
  transaction: QuestTransaction,
  input: {
    questId: string;
    workerIds: string[];
    startTime: Date;
    dueAt: Date | null;
  }
): Promise<boolean> => {
  if (!input.dueAt) return false;
  const workerIds = [...new Set(input.workerIds)].sort();
  if (workerIds.length === 0) return false;

  await transaction
    .select({ id: authUser.id })
    .from(authUser)
    .where(inArray(authUser.id, workerIds))
    .orderBy(asc(authUser.id))
    .for('update');

  const [conflict] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .innerJoin(quest, eq(quest.id, questAssignment.questId))
    .where(
      and(
        inArray(questAssignment.workerId, workerIds),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
        ne(quest.id, input.questId),
        lt(quest.startTime, input.dueAt),
        gt(quest.dueAt, input.startTime)
      )
    )
    .limit(1);
  return conflict !== undefined;
};
