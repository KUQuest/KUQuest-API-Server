import { t } from 'elysia';

export const jobStatusSchema = t.Union([
  t.Literal('OPEN'),
  t.Literal('ASSIGNED'),
  t.Literal('OVERDUE'),
  t.Literal('IN_REVIEW'),
  t.Literal('DISPUTED'),
  t.Literal('SETTLED'),
  t.Literal('RETURNED'),
  t.Literal('CANCELLED'),
  t.Literal('EXPIRED'),
]);

export const jobApplicationStatusSchema = t.Union([
  t.Literal('PENDING'),
  t.Literal('SELECTED'),
  t.Literal('WITHDRAWN'),
  t.Literal('REJECTED'),
  t.Literal('REMOVED_WORKER_ENGAGED'),
]);

export const fundedJobSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  employer_user_id: t.String(),
  intended_payee_user_id: t.Union([t.String(), t.Null()]),
  title: t.String(),
  description: t.String(),
  status: jobStatusSchema,
  job_amount: t.Integer({ minimum: 1 }),
  platform_fee_rate_bps: t.Integer({ minimum: 0, maximum: 10_000 }),
  platform_fee_amount: t.Integer({ minimum: 0 }),
  worker_net_amount: t.Integer({ minimum: 0 }),
  currency: t.Literal('THB'),
  application_deadline: t.String({ format: 'date-time' }),
  work_deadline: t.String({ format: 'date-time' }),
  review_deadline: t.Union([t.String({ format: 'date-time' }), t.Null()]),
  created_at: t.String({ format: 'date-time' }),
  updated_at: t.String({ format: 'date-time' }),
});

export const jobApplicationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  job_id: t.String({ format: 'uuid' }),
  worker_user_id: t.String(),
  status: jobApplicationStatusSchema,
  message: t.String(),
  created_at: t.String({ format: 'date-time' }),
  updated_at: t.String({ format: 'date-time' }),
});

export const workSubmissionSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  job_id: t.String({ format: 'uuid' }),
  worker_user_id: t.String(),
  status: t.Union([t.Literal('SUBMITTED'),t.Literal('APPROVED'),t.Literal('AUTO_APPROVED'),t.Literal('DISPUTED')]),
  summary: t.String(),
  review_deadline: t.String({ format: 'date-time' }),
  created_at: t.String({ format: 'date-time' }),
});

export const jobPageSchema = t.Object({
  items: t.Array(fundedJobSchema),
  next_cursor: t.Union([t.String(), t.Null()]),
});

export const jobApplicationPageSchema = t.Object({
  items: t.Array(jobApplicationSchema),
  next_cursor: t.Union([t.String(), t.Null()]),
});

export const jobIdParamsSchema = t.Object({
  job_id: t.String({ format: 'uuid' }),
});

export const idempotencyHeadersSchema = t.Object(
  {
    'idempotency-key': t.String({ minLength: 16, maxLength: 100 }),
    origin: t.Optional(t.String()),
    referer: t.Optional(t.String()),
  },
  { additionalProperties: true },
);
