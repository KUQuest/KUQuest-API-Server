import { questStatuses } from '@/modules/quest/quest.contract';

import { t } from 'elysia';

const counter = t.Integer({ minimum: 0 });

const adminQuestStatusCountsSchema = t.Object(
  Object.fromEntries(questStatuses.map((status) => [status, counter])) as Record<
    (typeof questStatuses)[number],
    typeof counter
  >,
);

export const adminOverviewResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    quests: t.Object({
      total: counter,
      hidden: counter,
      byStatus: adminQuestStatusCountsSchema,
    }),
    disputes: t.Object({
      total: counter,
      awaitingResolution: counter,
    }),
    payouts: t.Object({
      pendingAdminApproval: counter,
      inFlight: counter,
    }),
    members: t.Object({
      frozenWallets: counter,
      suspendedWallets: counter,
    }),
  }),
});

const safeIdentifierSchema = t.String({ minLength: 1, maxLength: 200, pattern: '\\S' });

export const adminActivityListQuerySchema = t.Object({
  action: t.Optional(safeIdentifierSchema),
  resourceType: t.Optional(safeIdentifierSchema),
  resourceId: t.Optional(safeIdentifierSchema),
  adminId: t.Optional(t.String({ format: 'uuid' })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
  cursor: t.Optional(t.String()),
  sort: t.Optional(t.Union([t.Literal('newest'), t.Literal('oldest')])),
});

export const adminActivityEntrySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  admin: t.Object({
    id: t.String({ format: 'uuid' }),
    firstName: t.String(),
    lastName: t.String(),
  }),
  action: t.String(),
  resourceType: t.String(),
  resourceId: t.String(),
  reasonCode: t.Nullable(t.String()),
  reasonCatalogVersion: t.Integer({ minimum: 1 }),
  resultVersion: t.Nullable(t.Integer()),
  resultTimestamp: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});

export const adminActivityListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminActivityEntrySchema),
    nextCursor: t.Nullable(t.String()),
  }),
});
