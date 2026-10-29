import { enqueuePushDeliveryInTransaction } from '@/modules/push';

import type { QuestTransaction } from '../../shared/work-chat/quest-work-chat.port';

export type QuestFailedPushReason = 'PROOF_NOT_APPROVED' | 'DUE_AT_MISSED';

type QuestFailedPushInput = {
  recipientMemberIds: string[];
  questId: string;
  reason: QuestFailedPushReason;
  now: Date;
};

/**
 * Queues one data-only Push per Worker with an Assignment when a Quest becomes `QUEST_FAILED`.
 * The Dispute window is short, so a Worker must learn of the failure outside the app.
 * `eventKey` is unique per Quest and recipient: a replay never creates a second alert.
 */
export const enqueueQuestFailedPush = async (
  transaction: QuestTransaction,
  input: QuestFailedPushInput
) => {
  const transitionId = `quest-v2:QUEST_FAILED:${input.questId}`;
  const data: Record<string, string> = {
    type: 'QUEST_FAILED',
    questId: input.questId,
    transitionId,
    failureReason: input.reason,
  };
  for (const recipientMemberId of new Set(input.recipientMemberIds)) {
    await enqueuePushDeliveryInTransaction(transaction, {
      recipientMemberId,
      eventKey: transitionId,
      eventType: 'QUEST_FAILED',
      title: 'Quest failed',
      body:
        input.reason === 'PROOF_NOT_APPROVED'
          ? 'The Hirer did not approve a Proof Submission, so the Quest failed. You can open a Dispute Case within 1 day.'
          : 'The Quest passed its due time without Proof, so it failed. You can open a Dispute Case within 1 day.',
      deepLink: `kuquest://quest/${input.questId}`,
      data,
      now: input.now,
    });
  }
};

export const enqueueProofNotApprovedPush = async (
  transaction: QuestTransaction,
  input: { recipientMemberId: string; assignmentId: string; questId: string; now: Date }
) => {
  const transitionId = `quest-v2:PROOF_NOT_APPROVED:${input.assignmentId}`;
  await enqueuePushDeliveryInTransaction(transaction, {
    recipientMemberId: input.recipientMemberId,
    eventKey: transitionId,
    eventType: 'PROOF_NOT_APPROVED',
    title: 'Proof not approved',
    body: 'The Hirer did not approve your Proof Submission, so your Assignment ended with no Reward. You can open a Dispute Case within 1 day after the Quest ends.',
    deepLink: `kuquest://quest/${input.questId}`,
    data: {
      type: 'PROOF_NOT_APPROVED',
      questId: input.questId,
      assignmentId: input.assignmentId,
      transitionId,
    },
    now: input.now,
  });
};
