import { t, type Static } from 'elysia';

import { adminOverviewQuestStates } from './admin-overview.contract';

const counterSchema = t.Integer({ minimum: 0 });

const adminQuestStateCountsSchema = t.Object(
  Object.fromEntries(adminOverviewQuestStates.map((status) => [status, counterSchema])) as Record<
    (typeof adminOverviewQuestStates)[number],
    typeof counterSchema
  >,
);

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
    members: t.Object({
      frozenWallets: counterSchema,
      suspendedWallets: counterSchema,
    }),
  }),
});

export type AdminOverviewData = Static<typeof adminOverviewResponseSchema>['data'];
