import { t, type Static } from 'elysia';
export const adminSearchResultLimit = 12;

export const adminSearchKindSchema = t.Union(
  [
    t.Literal('member'),
    t.Literal('quest'),
    t.Literal('payout'),
    t.Literal('dispute'),
    t.Literal('report'),
    t.Literal('conduct-report'),
    t.Literal('wallet'),
    t.Literal('activity'),
  ],
  {
    description: 'Supported resource type for Admin Search.',
  }
);

export const adminSearchQuerySchema = t.Object({
  q: t.String({
    description: 'Trimmed by the server. It must contain 1 to 100 characters.',
  }),
  kind: adminSearchKindSchema,
});

export const adminSearchItemSchema = t.Object({
  kind: adminSearchKindSchema,
  id: t.String({
    format: 'uuid',
    description: 'Internal UUID for the record.',
  }),
  resourceId: t.String({
    format: 'uuid',
    description: 'Canonical resource UUID used by the Admin web app to open the record.',
  }),
  displayId: t.Optional(
    t.String({ description: 'Readable identifier, when this record has one.' })
  ),
  studentId: t.Optional(t.Union([t.String(), t.Null()])),
  title: t.String({ description: 'Short title visible to an Admin.' }),
  status: t.Nullable(
    t.String({ description: 'Canonical status value. Null when this record type has no status.' })
  ),
  newestAt: t.Nullable(
    t.String({
      format: 'date-time',
      description: 'UTC timestamp used to sort results. Null when the record has no timestamp.',
    })
  ),
});

export const adminSearchResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(adminSearchItemSchema, { maxItems: adminSearchResultLimit }),
  }),
});

export type AdminSearchQuery = Static<typeof adminSearchQuerySchema>;
export type AdminSearchItem = Static<typeof adminSearchItemSchema>;
export type AdminSearchKind = Static<typeof adminSearchKindSchema>;
