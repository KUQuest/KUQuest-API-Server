import { quest, questAssignment } from '@/database/schema/quest.schema';
import { notifyAdminResourceUpdated } from '@/modules/admin/admin-update.delivery';

import { eq } from 'drizzle-orm';

import type { QuestTransaction } from './work-chat/quest-work-chat.port';

export const notifyAdminQuestUpdated = async (transaction: QuestTransaction, questId: string) =>
  notifyAdminResourceUpdated(transaction, 'QUEST', questId);

export const notifyAdminMembersUpdated = async (
  transaction: QuestTransaction,
  memberIds: readonly string[]
) =>
  Promise.all(
    [...new Set(memberIds)].map((memberId) =>
      notifyAdminResourceUpdated(transaction, 'MEMBER', memberId)
    )
  );

export const notifyAdminQuestMembersUpdated = async (
  transaction: QuestTransaction,
  questId: string
) => {
  const [questRow] = await transaction
    .select({ hirerId: quest.hirerId })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!questRow) return;

  const assignmentRows = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(eq(questAssignment.questId, questId));
  const memberIds = new Set([questRow.hirerId, ...assignmentRows.map(({ workerId }) => workerId)]);

  await notifyAdminMembersUpdated(transaction, [...memberIds]);
};

export const notifyAdminQuestAndMembersUpdated = async (
  transaction: QuestTransaction,
  questId: string
) => {
  await notifyAdminQuestUpdated(transaction, questId);
  await notifyAdminQuestMembersUpdated(transaction, questId);
};
