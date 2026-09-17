import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t, type Static } from 'elysia';

export const notificationCategorySchema = t.Union([
  t.Literal('CANDIDATE'),
  t.Literal('QUEST_STATE'),
  t.Literal('PROOF'),
  t.Literal('CHAT'),
  t.Literal('FINANCE'),
]);

export const notificationSeveritySchema = t.Union([
  t.Literal('info'),
  t.Literal('success'),
  t.Literal('warning'),
  t.Literal('neutral'),
]);

export const notificationActorSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  displayName: t.String(),
});

export const notificationQuestSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  title: t.String(),
  state: t.String(),
});

export const notificationActionSchema = t.Object({
  label: t.String(),
  route: t.String(),
});

export const notificationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  category: t.String(),
  type: t.String(),
  severity: notificationSeveritySchema,
  title: t.String(),
  message: t.String(),
  actor: t.Nullable(notificationActorSchema),
  quest: t.Nullable(notificationQuestSchema),
  action: notificationActionSchema,
  readAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});

export const notificationListQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
    cursor: t.Optional(t.String()),
    unreadOnly: t.Optional(t.Boolean()),
  },
  { additionalProperties: false }
);

export const notificationListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(notificationSchema),
    nextCursor: t.Nullable(t.String()),
    unreadCount: t.Integer({ minimum: 0 }),
  }),
});

export const notificationUnreadCountResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    unreadCount: t.Integer({ minimum: 0 }),
  }),
});

export const notificationDetailParamsSchema = t.Object({
  notificationId: t.String({ format: 'uuid' }),
});

export const notificationReadResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    id: t.String({ format: 'uuid' }),
    readAt: t.String({ format: 'date-time' }),
  }),
});

export const notificationMarkAllReadResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    updatedCount: t.Integer({ minimum: 0 }),
  }),
});

export const registerDeviceBodySchema = t.Object(
  {
    token: t.String({ minLength: 1, maxLength: 500 }),
    platform: t.Optional(t.Literal('ANDROID')),
  },
  { additionalProperties: false }
);

export const registerDeviceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    registered: t.Literal(true),
  }),
});

export const unregisterDeviceParamsSchema = t.Object({
  token: t.String({ minLength: 1, maxLength: 500 }),
});

export const unregisterDeviceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    unregistered: t.Literal(true),
  }),
});

export type NotificationListQuery = Static<typeof notificationListQuerySchema>;
export type RegisterDeviceInput = Static<typeof registerDeviceBodySchema>;
export type NotificationDetailParams = Static<typeof notificationDetailParamsSchema>;
export type UnregisterDeviceParams = Static<typeof unregisterDeviceParamsSchema>;
