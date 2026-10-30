import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t } from 'elysia';

import { memberNotificationResults, memberNotificationTypes } from './notification.types';

const literalUnion = <T extends readonly string[]>(values: T) =>
  t.Union(values.map((value) => t.Literal(value)) as never[]);

export const listNotificationsQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
    cursor: t.Optional(t.String()),
    unreadOnly: t.Optional(t.Boolean()),
  },
  { additionalProperties: false }
);

export const markNotificationsReadSchema = t.Object(
  {
    ids: t.Optional(t.Array(t.String({ format: 'uuid' }), { minItems: 1, maxItems: 100 })),
    all: t.Optional(t.Literal(true)),
  },
  { additionalProperties: false }
);

const notificationItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  type: literalUnion(memberNotificationTypes),
  createdAt: t.String({ format: 'date-time' }),
  readAt: t.Nullable(t.String({ format: 'date-time' })),
  questId: t.Nullable(t.String({ format: 'uuid' })),
  result: t.Nullable(literalUnion(memberNotificationResults)),
  expiresAt: t.Nullable(t.String({ format: 'date-time' })),
});

export const notificationListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(notificationItemSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});

export const notificationUnreadCountResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ count: t.Integer({ minimum: 0 }) }),
});
