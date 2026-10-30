import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t } from 'elysia';

import {
  memberNotificationActorRoles,
  memberNotificationCancellationReasons,
  memberNotificationCategories,
  memberNotificationDisputeStatuses,
  memberNotificationFailureReasons,
  memberNotificationResults,
  memberNotificationTypes,
} from './notification.types';

const literalUnion = <T extends readonly string[]>(values: T) =>
  t.Union(values.map((value) => t.Literal(value)) as never[]);

export const listNotificationsQuerySchema = t.Object(
  {
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
    cursor: t.Optional(t.String()),
    unreadOnly: t.Optional(t.Boolean()),
    /** One value, a repeated key, or a comma list. Several categories combine. */
    category: t.Optional(t.ArrayQuery(literalUnion(memberNotificationCategories))),
  },
  { additionalProperties: false }
);

export const markNotificationsReadSchema = t.Object(
  {
    ids: t.Optional(t.Array(t.String({ format: 'uuid' }), { minItems: 1, maxItems: 100 })),
    all: t.Optional(t.Literal(true)),
    /** Only with `all`. */
    category: t.Optional(
      t.Union([
        literalUnion(memberNotificationCategories),
        t.Array(literalUnion(memberNotificationCategories), { minItems: 1, maxItems: 3 }),
      ])
    ),
  },
  { additionalProperties: false }
);

export const dismissNotificationsSchema = t.Object(
  {
    ids: t.Array(t.String({ format: 'uuid' }), { minItems: 1, maxItems: 100 }),
  },
  { additionalProperties: false }
);

const notificationItemSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  type: literalUnion(memberNotificationTypes),
  category: literalUnion(memberNotificationCategories),
  createdAt: t.String({ format: 'date-time' }),
  readAt: t.Nullable(t.String({ format: 'date-time' })),
  questId: t.Nullable(t.String({ format: 'uuid' })),
  questTitle: t.Nullable(t.String()),
  actorRole: t.Nullable(literalUnion(memberNotificationActorRoles)),
  result: t.Nullable(literalUnion(memberNotificationResults)),
  expiresAt: t.Nullable(t.String({ format: 'date-time' })),
  cancellationReason: t.Nullable(literalUnion(memberNotificationCancellationReasons)),
  failureReason: t.Nullable(literalUnion(memberNotificationFailureReasons)),
  assignmentId: t.Nullable(t.String({ format: 'uuid' })),
  disputeCaseId: t.Nullable(t.String({ format: 'uuid' })),
  disputeStatus: t.Nullable(literalUnion(memberNotificationDisputeStatuses)),
  viewerWon: t.Nullable(t.Boolean()),
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
  data: t.Object({
    count: t.Integer({ minimum: 0 }),
    byCategory: t.Object({
      PENALTY: t.Integer({ minimum: 0 }),
      QUEST: t.Integer({ minimum: 0 }),
      DISPUTE: t.Integer({ minimum: 0 }),
    }),
  }),
});
