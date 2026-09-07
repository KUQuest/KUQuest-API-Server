import {
  chatConversation,
} from '@/database/schema/work-chat.schema';
import type { QuestTransaction } from '@/modules/quest';

import { and, eq, inArray } from 'drizzle-orm';

type CandidateInquiryCloseOptions = {
  questId: string;
  questStatus: string;
  closedAt: Date;
  workerIds?: readonly string[];
};

/**
 * Quest calls this through the Work Chat transaction seam. Closed inquiries
 * remain stored for retention and moderation, but are no longer visible to
 * Members.
 */
export const closeCandidateInquiries = async (
  transaction: QuestTransaction,
  options: CandidateInquiryCloseOptions,
): Promise<number> => {
  const conditions = [
    eq(chatConversation.questId, options.questId),
    eq(chatConversation.type, 'CONVERSATION_CANDIDATE_INQUIRY'),
    eq(chatConversation.state, 'INQUIRY_OPEN'),
  ];
  if (options.workerIds) {
    if (options.workerIds.length === 0) return 0;
    conditions.push(inArray(chatConversation.candidateWorkerId, options.workerIds));
  }

  const inquiries = await transaction
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(and(...conditions))
    .for('update');
  if (inquiries.length === 0) return 0;

  await transaction
    .update(chatConversation)
    .set({
      state: 'INQUIRY_CLOSED',
      closedAt: options.closedAt,
      questStatus: options.questStatus,
      updatedAt: options.closedAt,
    })
    .where(inArray(chatConversation.id, inquiries.map(({ id }) => id)));

  return inquiries.length;
};

export const closeCandidateInquiriesForAcceptedWorkers = async (
  transaction: QuestTransaction,
  options: CandidateInquiryCloseOptions,
): Promise<number> => {
  if (options.questStatus === 'QUEST_ASSIGNED') {
    return closeCandidateInquiries(transaction, { ...options, workerIds: undefined });
  }

  return closeCandidateInquiries(transaction, options);
};
