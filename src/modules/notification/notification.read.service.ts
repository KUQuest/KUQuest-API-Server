import { db } from '@/database/client';
import { memberNotification } from '@/database/schema/notification.schema';
import type { CursorPayload } from '@/shared/cursor';
import { CursorInputError } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, count, eq, inArray, isNull } from 'drizzle-orm';

import type { MemberNotificationResult, MemberNotificationType } from './notification.types';

export type MemberNotificationItem = {
  id: string;
  type: MemberNotificationType;
  createdAt: Date;
  readAt: Date | null;
  questId: string | null;
  result: MemberNotificationResult | null;
  expiresAt: Date | null;
};

/** Reads one page of the Member's own inbox, newest first. */
export const listMemberNotifications = async (
  memberId: string,
  options: { limit: number; cursor?: CursorPayload | undefined; unreadOnly?: boolean }
) => {
  const page = await readKeysetPage<MemberNotificationItem>({
    anchor: { time: memberNotification.createdAt, id: memberNotification.id },
    cursor: options.cursor,
    limit: options.limit,
    where: and(
      eq(memberNotification.memberId, memberId),
      options.unreadOnly ? isNull(memberNotification.readAt) : undefined
    ),
    read: async ({ where, orderBy, limit }) =>
      (await db
        .select({
          id: memberNotification.id,
          type: memberNotification.type,
          createdAt: memberNotification.createdAt,
          readAt: memberNotification.readAt,
          questId: memberNotification.questId,
          result: memberNotification.result,
          expiresAt: memberNotification.expiresAt,
        })
        .from(memberNotification)
        .where(where)
        .orderBy(...orderBy)
        .limit(limit)) as MemberNotificationItem[],
    rowCursor: (row) => ({ startTime: row.createdAt, id: row.id }),
    invalidCursor: () => new CursorInputError('INVALID_CURSOR', 'cursor is invalid'),
  });
  return { items: page.rows, nextCursor: page.nextCursor };
};

export const countUnreadMemberNotifications = async (memberId: string): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(memberNotification)
    .where(and(eq(memberNotification.memberId, memberId), isNull(memberNotification.readAt)));
  return row?.value ?? 0;
};

/**
 * Marks the Member's own unread rows as read. A row that is already read keeps its `readAt`.
 * An id of another Member matches nothing and is ignored.
 */
export const markMemberNotificationsRead = async (
  memberId: string,
  target: { ids: string[] } | { all: true },
  now: Date
): Promise<void> => {
  await db
    .update(memberNotification)
    .set({ readAt: now })
    .where(
      and(
        eq(memberNotification.memberId, memberId),
        isNull(memberNotification.readAt),
        'ids' in target ? inArray(memberNotification.id, target.ids) : undefined
      )
    );
};
