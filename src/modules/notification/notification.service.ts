import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  notification,
  notificationDevice,
  type NewNotificationRow,
} from '@/database/schema/notification.schema';
import { quest } from '@/database/schema/quest.schema';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/shared/cursor';

import { and, count, desc, eq, isNull, lt, or } from 'drizzle-orm';

import { decodeNotificationCursor, encodeNotificationCursor } from './notification.cursor';
import type { NotificationListQuery } from './notification.schema';

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface CreateNotificationInput {
  recipientId: string;
  actorId?: string | null;
  category: string;
  type: string;
  severity?: 'info' | 'success' | 'warning' | 'neutral';
  title: string;
  message: string;
  resourceType: string;
  resourceId: string;
  actionRoute: string;
  actionLabel: string;
}

export const createNotification = async (
  input: CreateNotificationInput,
  executor: Database = db
) => {
  const row: NewNotificationRow = {
    recipientId: input.recipientId,
    actorId: input.actorId ?? null,
    category: input.category,
    type: input.type,
    severity: input.severity ?? 'info',
    title: input.title,
    message: input.message,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    actionRoute: input.actionRoute,
    actionLabel: input.actionLabel,
  };

  const [inserted] = await executor.insert(notification).values(row).returning();
  return inserted;
};

export const listNotifications = async (recipientId: string, query: NotificationListQuery) => {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const cursor = decodeNotificationCursor(query.cursor);

  const conditions = [eq(notification.recipientId, recipientId)];

  if (query.unreadOnly) {
    conditions.push(isNull(notification.readAt));
  }

  if (cursor) {
    const cursorTime = new Date(cursor.createdAt);
    conditions.push(
      or(
        lt(notification.createdAt, cursorTime),
        and(eq(notification.createdAt, cursorTime), lt(notification.id, cursor.id))
      )!
    );
  }

  const rows = await db
    .select({
      id: notification.id,
      category: notification.category,
      type: notification.type,
      severity: notification.severity,
      title: notification.title,
      message: notification.message,
      resourceType: notification.resourceType,
      resourceId: notification.resourceId,
      actionRoute: notification.actionRoute,
      actionLabel: notification.actionLabel,
      readAt: notification.readAt,
      createdAt: notification.createdAt,
      actorId: authUser.id,
      actorFirstName: authUser.firstName,
      actorLastName: authUser.lastName,
      questId: quest.id,
      questTitle: quest.title,
      questStatus: quest.questStatus,
    })
    .from(notification)
    .leftJoin(authUser, eq(notification.actorId, authUser.id))
    .leftJoin(quest, eq(notification.resourceId, quest.id))
    .where(and(...conditions))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const items = page.map((row) => ({
    id: row.id,
    category: row.category,
    type: row.type,
    severity: (row.severity as 'info' | 'success' | 'warning' | 'neutral') || 'info',
    title: row.title,
    message: row.message,
    actor: row.actorId
      ? {
          id: row.actorId,
          displayName: `${row.actorFirstName ?? ''} ${row.actorLastName ?? ''}`.trim(),
        }
      : null,
    quest: row.questId
      ? {
          id: row.questId,
          title: row.questTitle ?? '',
          state: row.questStatus ?? '',
        }
      : null,
    action: {
      label: row.actionLabel,
      route: row.actionRoute,
    },
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }));

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeNotificationCursor({ createdAt: last.createdAt, id: last.id }) : null;

  const [countResult] = await db
    .select({ value: count() })
    .from(notification)
    .where(and(eq(notification.recipientId, recipientId), isNull(notification.readAt)));

  return {
    items,
    nextCursor,
    unreadCount: Number(countResult?.value ?? 0),
  };
};

export const getUnreadNotificationCount = async (recipientId: string): Promise<number> => {
  const [result] = await db
    .select({ value: count() })
    .from(notification)
    .where(and(eq(notification.recipientId, recipientId), isNull(notification.readAt)));

  return Number(result?.value ?? 0);
};

export const markNotificationRead = async (
  recipientId: string,
  notificationId: string,
  now = new Date()
): Promise<{ id: string; readAt: string } | { outcome: 'not-found' }> => {
  const [updated] = await db
    .update(notification)
    .set({ readAt: now })
    .where(and(eq(notification.id, notificationId), eq(notification.recipientId, recipientId)))
    .returning({ id: notification.id, readAt: notification.readAt });

  if (!updated || !updated.readAt) {
    return { outcome: 'not-found' };
  }

  return {
    id: updated.id,
    readAt: updated.readAt.toISOString(),
  };
};

export const markAllNotificationsRead = async (
  recipientId: string,
  now = new Date()
): Promise<{ updatedCount: number }> => {
  const result = await db
    .update(notification)
    .set({ readAt: now })
    .where(and(eq(notification.recipientId, recipientId), isNull(notification.readAt)))
    .returning({ id: notification.id });

  return { updatedCount: result.length };
};

export const registerDevice = async (
  memberId: string,
  token: string,
  platform = 'ANDROID'
): Promise<void> => {
  await db
    .insert(notificationDevice)
    .values({
      memberId,
      token,
      platform,
    })
    .onConflictDoUpdate({
      target: notificationDevice.token,
      set: {
        memberId,
        platform,
        updatedAt: new Date(),
      },
    });
};

export const unregisterDevice = async (memberId: string, token: string): Promise<void> => {
  await db
    .delete(notificationDevice)
    .where(and(eq(notificationDevice.memberId, memberId), eq(notificationDevice.token, token)));
};
