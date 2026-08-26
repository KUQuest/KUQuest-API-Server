import { t } from 'elysia';

export const tagSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
});

export const tagListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Array(tagSchema),
});
