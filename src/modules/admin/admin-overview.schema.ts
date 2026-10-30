import { t, type Static } from 'elysia';

import { adminOverviewQuestStates } from './admin-overview.contract';

const counterSchema = t.Integer({ minimum: 0 });

const adminQuestStateCountsSchema = t.Object(
  Object.fromEntries(adminOverviewQuestStates.map((status) => [status, counterSchema])) as Record<
    (typeof adminOverviewQuestStates)[number],
    typeof counterSchema
  >
);

const dateTimeSchema = t.String({ format: 'date-time' });
const uuidSchema = t.String({ format: 'uuid' });

const adminOverviewQueueItemSchema = t.Object({
  id: uuidSchema,
  displayId: t.String(),
  title: t.String(),
  createdAt: dateTimeSchema,
});

const adminOverviewQueueSchema = t.Object({
  count: counterSchema,
  state: t.Union([t.Literal('CLEAR'), t.Literal('OPEN')]),
  oldest: t.Union([adminOverviewQueueItemSchema, t.Null()]),
});

export const adminOverviewResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    quests: t.Object({
      total: counterSchema,
      hidden: counterSchema,
      byState: adminQuestStateCountsSchema,
    }),
    disputes: t.Object({
      total: counterSchema,
      awaitingResolution: counterSchema,
    }),
    payouts: t.Object({
      pendingAdminApproval: counterSchema,
      inFlight: counterSchema,
    }),
    reports: t.Object({
      open: counterSchema,
    }),
    conductReports: t.Object({
      open: counterSchema,
    }),
    members: t.Object({
      byStatus: t.Object({
        NORMAL: counterSchema,
        FLAG: counterSchema,
        TEMP_BAN: counterSchema,
        PERM_BAN: counterSchema,
      }),
      frozenWallets: counterSchema,
      suspendedWallets: counterSchema,
    }),
    wallets: t.Object({
      byStatus: t.Object({
        ACTIVE: counterSchema,
        FROZEN: counterSchema,
        SUSPENDED: counterSchema,
        CLOSED: counterSchema,
      }),
    }),
    queues: t.Object({
      payouts: adminOverviewQueueSchema,
      disputes: adminOverviewQueueSchema,
      reports: adminOverviewQueueSchema,
      conductReports: adminOverviewQueueSchema,
    }),
  }),
});

export type AdminOverviewData = Static<typeof adminOverviewResponseSchema>['data'];
