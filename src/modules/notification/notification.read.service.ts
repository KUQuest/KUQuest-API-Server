import { db } from '@/database/client';
import { memberNotification } from '@/database/schema/notification.schema';
import type { CursorPayload } from '@/shared/cursor';
import { CursorInputError } from '@/shared/cursor';
import { readKeysetPage } from '@/shared/keyset-page';

import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  categoryOfNotificationType,
  memberNotificationCategories,
  memberNotificationTypes,
  penaltyMemberNotificationTypes,
} from './notification.types';
import type {
  MemberNotificationActorRole,
  MemberNotificationCancellationReason,
  MemberNotificationCategory,
  MemberNotificationDisputeStatus,
  MemberNotificationFailureReason,
  MemberNotificationResult,
  MemberNotificationType,
} from './notification.types';

export type MemberNotificationItem = {
  id: string;
  type: MemberNotificationType;
  createdAt: Date;
  readAt: Date | null;
  questId: string | null;
  questTitle: string | null;
  actorRole: MemberNotificationActorRole | null;
  result: MemberNotificationResult | null;
  expiresAt: Date | null;
  cancellationReason: MemberNotificationCancellationReason | null;
  failureReason: MemberNotificationFailureReason | null;
  assignmentId: string | null;
  disputeCaseId: string | null;
  disputeStatus: MemberNotificationDisputeStatus | null;
  viewerWon: boolean | null;
};

export type UnreadCountByCategory = Record<MemberNotificationCategory, number>;

const typesOfCategories = (categories: readonly MemberNotificationCategory[]) =>
  memberNotificationTypes.filter((type) => categories.includes(categoryOfNotificationType(type)));

/** Reads one page of the Member's own inbox, newest first. A dismissed row is hidden. */
export const listMemberNotifications = async (
  memberId: string,
  options: {
    limit: number;
    cursor?: CursorPayload | undefined;
    unreadOnly?: boolean;
    categories?: readonly MemberNotificationCategory[] | undefined;
  }
) => {
  const page = await readKeysetPage<MemberNotificationItem>({
    anchor: { time: memberNotification.createdAt, id: memberNotification.id },
    cursor: options.cursor,
    limit: options.limit,
    where: and(
      eq(memberNotification.memberId, memberId),
      isNull(memberNotification.dismissedAt),
      options.unreadOnly ? isNull(memberNotification.readAt) : undefined,
      options.categories?.length
        ? inArray(memberNotification.type, typesOfCategories(options.categories))
        : undefined
    ),
    read: async ({ where, orderBy, limit }) =>
      (await db
        .select({
          id: memberNotification.id,
          type: memberNotification.type,
          createdAt: memberNotification.createdAt,
          readAt: memberNotification.readAt,
          questId: memberNotification.questId,
          questTitle: memberNotification.questTitle,
          actorRole: memberNotification.actorRole,
          result: memberNotification.result,
          expiresAt: memberNotification.expiresAt,
          cancellationReason: memberNotification.cancellationReason,
          failureReason: memberNotification.failureReason,
          assignmentId: memberNotification.assignmentId,
          disputeCaseId: memberNotification.disputeCaseId,
          disputeStatus: memberNotification.disputeStatus,
          viewerWon: memberNotification.viewerWon,
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

/** Counts the Member's unread, not dismissed rows by category. `count` is the sum. */
export const countUnreadMemberNotifications = async (
  memberId: string
): Promise<{ count: number; byCategory: UnreadCountByCategory }> => {
  const rows = await db
    .select({ type: memberNotification.type, value: count() })
    .from(memberNotification)
    .where(
      and(
        eq(memberNotification.memberId, memberId),
        isNull(memberNotification.readAt),
        isNull(memberNotification.dismissedAt)
      )
    )
    .groupBy(memberNotification.type);
  const byCategory = Object.fromEntries(
    memberNotificationCategories.map((category) => [category, 0])
  ) as UnreadCountByCategory;
  for (const row of rows) {
    byCategory[categoryOfNotificationType(row.type as MemberNotificationType)] += row.value;
  }
  return { count: byCategory.PENALTY + byCategory.QUEST + byCategory.DISPUTE, byCategory };
};

/**
 * Marks the Member's own unread rows as read. A row that is already read keeps its `readAt`.
 * An id of another Member matches nothing and is ignored. `categories` narrows `all` only.
 */
export const markMemberNotificationsRead = async (
  memberId: string,
  target:
    | { ids: string[] }
    | { all: true; categories?: readonly MemberNotificationCategory[] | undefined },
  now: Date
): Promise<void> => {
  await db
    .update(memberNotification)
    .set({ readAt: now })
    .where(
      and(
        eq(memberNotification.memberId, memberId),
        isNull(memberNotification.readAt),
        'ids' in target ? inArray(memberNotification.id, target.ids) : undefined,
        'categories' in target && target.categories?.length
          ? inArray(memberNotification.type, typesOfCategories(target.categories))
          : undefined
      )
    );
};

/**
 * Hides the Member's own rows from the inbox. It also marks them read, so a hidden row never
 * stays in the unread count; a row that is already read keeps its `readAt`.
 * A penalty row cannot be dismissed: if one requested id is the Member's own penalty row, the
 * result is `NOT_DISMISSABLE` and nothing changes. Ids of other Members are ignored.
 * A repeat keeps the first `dismissedAt`.
 */
export const dismissMemberNotifications = async (
  memberId: string,
  ids: string[],
  now: Date
): Promise<'DISMISSED' | 'NOT_DISMISSABLE'> =>
  db.transaction(async (transaction) => {
    const own = and(eq(memberNotification.memberId, memberId), inArray(memberNotification.id, ids));
    const [penaltyRow] = await transaction
      .select({ id: memberNotification.id })
      .from(memberNotification)
      .where(and(own, inArray(memberNotification.type, [...penaltyMemberNotificationTypes])))
      .limit(1);
    if (penaltyRow) return 'NOT_DISMISSABLE';
    await transaction
      .update(memberNotification)
      .set({
        dismissedAt: now,
        readAt: sql`coalesce(${memberNotification.readAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(and(own, isNull(memberNotification.dismissedAt)));
    return 'DISMISSED';
  });
