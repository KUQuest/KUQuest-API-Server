import { t } from 'elysia';

export const workExperienceParamsSchema = t.Object({
  experienceId: t.String({ format: 'uuid' }),
});

const dateSchema = t.String({
  format: 'date',
  example: '2023-06-01',
  error: 'Date must be a calendar date in YYYY-MM-DD format',
});

export const workExperienceCreateSchema = t.Object(
  {
    title: t.String({ minLength: 1, maxLength: 120, pattern: '\\S' }),
    employmentType: t.String({ minLength: 1, maxLength: 50, pattern: '\\S' }),
    organization: t.Optional(t.Nullable(t.String({ maxLength: 120, pattern: '\\S' }))),
    description: t.Optional(t.Nullable(t.String({ maxLength: 1000, pattern: '\\S' }))),
    startedAt: dateSchema,
    endedAt: t.Optional(t.Nullable(dateSchema)),
  },
  { additionalProperties: false },
);

export const workExperienceUpdateSchema = t.Partial(workExperienceCreateSchema);

export const workExperienceSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  version: t.Integer({ minimum: 1 }),
  title: t.String(),
  employmentType: t.String(),
  organization: t.Nullable(t.String()),
  description: t.Nullable(t.String()),
  startedAt: t.String({ format: 'date' }),
  endedAt: t.Nullable(t.String({ format: 'date' })),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});

export const workExperienceResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ experience: workExperienceSchema }),
});

export const workExperienceDeleteResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ version: t.Integer({ minimum: 1 }) }),
});

export const workExperienceListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Array(workExperienceSchema),
});
