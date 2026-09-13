import { t, type Static } from 'elysia';

const actionFilterSchema = t.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,99}$',
});
const resourceIdFilterSchema = t.String({
  minLength: 1,
  maxLength: 255,
  pattern: '\\S',
});

export const adminActivityListQuerySchema = t.Object({
  action: t.Optional(actionFilterSchema),
  resourceType: t.Optional(actionFilterSchema),
  resourceId: t.Optional(resourceIdFilterSchema),
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
  resultVersion: t.Nullable(t.Integer({ minimum: 1 })),
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

export type AdminActivityListQuery = Static<typeof adminActivityListQuerySchema>;
export type AdminActivityListResponse = Static<typeof adminActivityListResponseSchema>['data'];
