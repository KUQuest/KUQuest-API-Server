import { t } from 'elysia';

const majorSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String({ example: 'Computer Engineering' }),
  faculty: t.Object({
    id: t.String({ format: 'uuid' }),
    name: t.String({ example: 'Engineering' }),
  }),
});

export const profileResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    email: t.String({ format: 'email', example: 'student@ku.th' }),
    firstName: t.String(),
    lastName: t.String(),
    bio: t.Nullable(t.String()),
    telephone: t.Nullable(t.String({ example: '0800000000' })),
    studentId: t.Nullable(t.String({ example: '6500000000' })),
    academicYear: t.Nullable(t.Integer()),
    major: t.Nullable(majorSchema),
  }),
});
