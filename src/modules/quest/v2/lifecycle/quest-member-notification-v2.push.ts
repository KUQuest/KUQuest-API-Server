import { quest } from '@/database/schema/quest.schema';
import {
  insertMemberNotificationInTransaction,
  notificationPushData,
} from '@/modules/notification';
import type {
  MemberNotificationActorRole,
  MemberNotificationCancellationReason,
  MemberNotificationFailureReason,
  MemberNotificationType,
} from '@/modules/notification';
import { enqueuePushDeliveryInTransaction } from '@/modules/push';

import { eq } from 'drizzle-orm';

import type { QuestTransaction } from '../../shared/work-chat/quest-work-chat.port';

type QuestMemberNotificationPushInput = {
  recipientMemberId: string;
  type: MemberNotificationType;
  /** The role the recipient held in the Quest at Event time. */
  actorRole: MemberNotificationActorRole;
  questId: string;
  /** Used for the inbox row and the Push delivery. */
  eventKey: string;
  expiresAt?: Date;
  cancellationReason?: MemberNotificationCancellationReason;
  failureReason?: MemberNotificationFailureReason;
  assignmentId?: string;
  title: string;
  body: string;
  deepLink: string;
  /** Push data of the Event. The common inbox keys are added on top. */
  data: Record<string, string>;
  now: Date;
};

/**
 * Records the inbox row and queues the Push of one Quest Event for one recipient.
 * Both writes use the caller's transaction, so a Push never exists without its inbox row.
 * A replay with the same `eventKey` makes no second row and no second Push.
 */
export const enqueueQuestMemberNotificationPush = async (
  transaction: QuestTransaction,
  input: QuestMemberNotificationPushInput
) => {
  const [questRow] = await transaction
    .select({ title: quest.title })
    .from(quest)
    .where(eq(quest.id, input.questId))
    .limit(1);
  const row = await insertMemberNotificationInTransaction(transaction, {
    memberId: input.recipientMemberId,
    type: input.type,
    eventKey: input.eventKey,
    questId: input.questId,
    transitionId: input.eventKey,
    ...(questRow ? { questTitle: questRow.title } : {}),
    actorRole: input.actorRole,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.cancellationReason ? { cancellationReason: input.cancellationReason } : {}),
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    ...(input.assignmentId ? { assignmentId: input.assignmentId } : {}),
    now: input.now,
  });
  await enqueuePushDeliveryInTransaction(transaction, {
    recipientMemberId: input.recipientMemberId,
    eventKey: input.eventKey,
    eventType: input.type,
    title: input.title,
    body: input.body,
    deepLink: input.deepLink,
    data: {
      ...input.data,
      ...notificationPushData({
        notificationId: row.notificationId,
        type: input.type,
        questId: input.questId,
      }),
    },
    now: input.now,
  });
};
