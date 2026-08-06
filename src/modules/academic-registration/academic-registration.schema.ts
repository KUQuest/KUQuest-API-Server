import { t } from 'elysia';

const nameSchema = t.String({ minLength: 1, maxLength: 100, pattern: '\\S' });

export const academicRegistrationUpdateSchema = t.Object(
  {
    firstName: t.Optional(nameSchema),
    lastName: t.Optional(nameSchema),
    telephone: t.Optional(t.String({ pattern: '^0[0-9]{9}$', example: '0800000000' })),
    occupationId: t.Optional(t.String({ format: 'uuid' })),
    studentId: t.Optional(t.String({
      pattern: '^[0-9]{10}$',
      example: '6500000000',
      error: 'Student ID must be a 10-digit number',
    })),
    departmentId: t.Optional(t.String({ format: 'uuid' })),
    termsVersion: t.Optional(t.String({ minLength: 1, example: '2026-01-01' })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export const academicRegistrationUpdateResponseSchema = t.Object({
  success: t.Literal(true),
});

export const academicRegistrationStatusResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    firstName: t.String(),
    lastName: t.String(),
    telephone: t.Nullable(t.String({ example: '0800000000' })),
    occupationId: t.Nullable(t.String({ format: 'uuid' })),
    studentId: t.Nullable(t.String({ example: '6500000000' })),
    departmentId: t.Nullable(t.String({ format: 'uuid' })),
    termsAcceptedAt: t.Nullable(t.String({ format: 'date-time' })),
    termsVersion: t.Nullable(t.String({ example: '2026-01-01' })),
    completed: t.Boolean(),
  }),
});

export const academicRegistrationOptionsResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    occupations: t.Array(t.Object({
      id: t.String({ format: 'uuid' }),
      name: t.String({ example: 'Student' }),
      requiresStudentId: t.Boolean(),
    })),
    faculties: t.Array(t.Object({
      id: t.String({ format: 'uuid' }),
      name: t.String({ example: 'Engineering' }),
      departments: t.Array(t.Object({
        id: t.String({ format: 'uuid' }),
        name: t.String({ example: 'Computer Engineering' }),
      })),
    })),
  }),
});
