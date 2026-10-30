import { memberNotification } from '@/database/schema/notification.schema';
import {
  enqueuePushDeliveryInTransaction,
  type PushTransaction,
} from '@/modules/push/push.service';

import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type {
  MemberNotificationLadder,
  MemberNotificationResult,
  MemberNotificationSource,
  MemberNotificationType,
} from './notification.types';

export type RecordMemberNotificationInput = {
  memberId: string;
  type: MemberNotificationType;
  /** Unique per Member. A replay with the same key changes nothing. */
  eventKey: string;
  questId?: string;
  result?: MemberNotificationResult;
  ladder?: MemberNotificationLadder;
  source?: MemberNotificationSource;
  transitionId?: string;
  /** Ignored for `PERMANENT_BAN`. */
  expiresAt?: Date;
  now: Date;
};

export type RecordedMemberNotification = {
  notificationId: string;
  /** `false` when the same `eventKey` was recorded before. */
  created: boolean;
};

const pushText = (
  type: MemberNotificationType,
  result: MemberNotificationResult | undefined
): { title: string; body: string } => {
  switch (type) {
    case 'PENALTY_RED_FLAG_APPLIED':
      return { title: 'Red Flag applied', body: 'Your account received a Red Flag.' };
    case 'PENALTY_RED_FLAG_EXPIRED':
      return { title: 'Red Flag ended', body: 'Your Red Flag expired.' };
    case 'PENALTY_BAN_APPLIED':
      return {
        title: 'Account banned',
        body:
          result === 'PERMANENT_BAN'
            ? 'Your account has a permanent ban.'
            : 'Your account has a temporary ban.',
      };
    case 'PENALTY_BAN_ENDED':
      return { title: 'Ban ended', body: 'Your temporary ban ended.' };
    case 'CONDUCT_REPORT_UPHELD':
      return { title: 'Conduct Report upheld', body: 'A Conduct Report against you was upheld.' };
  }
};

/**
 * Records one Member Notification inbox row and queues its data-only Push in the caller's
 * transaction. The unique (`memberId`, `eventKey`) makes a replay a no-op: no second row
 * and no second Push. The Push carries codes only, never the reporter, Message text, or Proof.
 */
export const recordMemberNotificationInTransaction = async (
  transaction: PushTransaction,
  input: RecordMemberNotificationInput
): Promise<RecordedMemberNotification> => {
  const expiresAt = input.result === 'PERMANENT_BAN' ? null : (input.expiresAt ?? null);
  const [inserted] = await transaction
    .insert(memberNotification)
    .values({
      id: randomUUID(),
      memberId: input.memberId,
      type: input.type,
      eventKey: input.eventKey,
      questId: input.questId ?? null,
      result: input.result ?? null,
      ladder: input.ladder ?? null,
      source: input.source ?? null,
      transitionId: input.transitionId ?? null,
      expiresAt,
      createdAt: input.now,
    })
    .onConflictDoNothing({ target: [memberNotification.memberId, memberNotification.eventKey] })
    .returning({ id: memberNotification.id });

  if (!inserted) {
    const [existing] = await transaction
      .select({ id: memberNotification.id })
      .from(memberNotification)
      .where(
        and(
          eq(memberNotification.memberId, input.memberId),
          eq(memberNotification.eventKey, input.eventKey)
        )
      )
      .limit(1);
    if (!existing) throw new Error('Member Notification could not be recorded.');
    return { notificationId: existing.id, created: false };
  }

  const data: Record<string, string> = { type: input.type, notificationId: inserted.id };
  if (input.questId) data.questId = input.questId;
  if (input.transitionId) data.transitionId = input.transitionId;
  if (input.result) data.result = input.result;
  if (input.ladder) data.ladder = input.ladder;
  if (input.source) data.source = input.source;
  if (expiresAt) data.expiresAt = expiresAt.toISOString();

  await enqueuePushDeliveryInTransaction(transaction, {
    recipientMemberId: input.memberId,
    eventKey: input.eventKey,
    eventType: input.type,
    ...pushText(input.type, input.result),
    deepLink: 'kuquest://notifications',
    data,
    now: input.now,
  });
  return { notificationId: inserted.id, created: true };
};
