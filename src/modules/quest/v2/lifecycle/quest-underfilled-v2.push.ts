import { enqueuePushDeliveryInTransaction } from '@/modules/push';

import type { QuestTransaction } from '../../shared/work-chat/quest-work-chat.port';
import type { QuestV2UnderfilledCancellationReason } from '../core/quest-v2.contract';

type UnderfilledPushInput = {
  recipientMemberIds: string[];
  questId: string;
  now: Date;
} & (
  | { type: 'UNDERFILLED_DECISION_PENDING' | 'UNDERFILLED_CONSENT_PENDING'; expiresAt: Date }
  | { type: 'UNDERFILLED_COMPLETED' }
  | { type: 'UNDERFILLED_CANCELLED'; reason: QuestV2UnderfilledCancellationReason }
  | { type: 'QUEST_ASSIGNED' }
);

const copy = {
  UNDERFILLED_DECISION_PENDING: {
    title: 'Your Quest is not full',
    body: 'Not enough Workers joined. Choose to proceed or cancel within 10 minutes.',
  },
  UNDERFILLED_CONSENT_PENDING: {
    title: 'Response needed',
    body: 'The Quest Reward changed because the Quest is not full. Accept or decline within 10 minutes.',
  },
  UNDERFILLED_COMPLETED: {
    title: 'Quest confirmed',
    body: 'All Workers accepted the revised Quest Reward. The Quest is assigned.',
  },
  QUEST_ASSIGNED: {
    title: 'Quest is full',
    body: 'All Worker slots are filled. The Quest is assigned.',
  },
  UNDERFILLED_CANCELLED: {
    title: 'Quest cancelled',
    body: 'The Quest was cancelled before all Workers accepted.',
  },
} as const;

const cancelledBody: Record<QuestV2UnderfilledCancellationReason, string> = {
  HIRER_CANCELLED: 'The Hirer cancelled the Quest because it was not full.',
  HIRER_NO_DECISION: 'The Hirer did not decide in time, so the Quest was cancelled.',
  WORKER_DECLINED: 'A Worker declined the revised Quest Reward, so the Quest was cancelled.',
  CONSENT_TIMEOUT: 'Not every Worker responded in time, so the Quest was cancelled.',
};

/**
 * Queues one data-only Push per recipient for an underfilled transition.
 * `transitionId` is the delivery `eventKey`: it is unique per transition and recipient,
 * so a replay or retry never creates a second alert, and the client can drop duplicates.
 * The Push worker drops a delivery whose underfilled state changed before it was sent.
 */
export const enqueueUnderfilledPush = async (
  transaction: QuestTransaction,
  scopeId: string,
  input: UnderfilledPushInput
) => {
  const transitionId = `quest-v2:${input.type}:${scopeId}`;
  const text =
    input.type === 'UNDERFILLED_CANCELLED'
      ? { ...copy.UNDERFILLED_CANCELLED, body: cancelledBody[input.reason] }
      : copy[input.type];
  const isConsent = input.type === 'UNDERFILLED_CONSENT_PENDING';
  const data: Record<string, string> = {
    type: input.type,
    questId: input.questId,
    transitionId,
    // The Push worker compares the decision state with `type` before it sends.
    ...(input.type.startsWith('UNDERFILLED_') ? { decisionId: scopeId } : {}),
    ...('expiresAt' in input ? { expiresAt: input.expiresAt.toISOString() } : {}),
    ...('reason' in input ? { cancellationReason: input.reason } : {}),
  };
  for (const recipientMemberId of new Set(input.recipientMemberIds)) {
    await enqueuePushDeliveryInTransaction(transaction, {
      recipientMemberId,
      eventKey: transitionId,
      eventType: input.type,
      ...text,
      deepLink: `kuquest://quest/${input.questId}${isConsent ? '/partial-start' : ''}`,
      data,
      now: input.now,
    });
  }
};
