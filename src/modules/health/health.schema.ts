import { t } from 'elysia';

export const healthResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    status: t.Literal('ok'),
    service: t.String({
      examples: ['kuquest-api-server'],
    }),
    timestamp: t.String({
      format: 'date-time',
      examples: ['2026-07-11T10:56:36.657Z'],
    }),
  }),
});