import { MAX_PAGE_LIMIT } from '@/shared/cursor';

import { t } from 'elysia';

export const tagSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
  nameTh: t.Nullable(t.String()),
});

export const tagListQuerySchema = t.Object(
  {
    q: t.Optional(t.String({ maxLength: 100 })),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
    cursor: t.Optional(t.String()),
  },
  { additionalProperties: false }
);

export const tagListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    items: t.Array(tagSchema),
    nextCursor: t.Nullable(t.String()),
  }),
});
export type TagListQuery = typeof tagListQuerySchema.static;
