import { t } from 'elysia';

export const avatarUploadSchema = t.Object(
  {
    avatar: t.File(),
  },
  {
    additionalProperties: false,
  },
);

export const avatarUploadResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    fileId: t.String({ format: 'uuid' }),
  }),
});

const departmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String({ example: 'Computer Engineering' }),
  faculty: t.Object({
    name: t.String({ example: 'Engineering' }),
  }),
});

const avatarSchema = t.Object({
  fileId: t.String({ format: 'uuid' }),
  url: t.String({ format: 'uri' }),
});

const nameSchema = t.String({ minLength: 1, maxLength: 100, pattern: '\\S' });

export const profileUpdateSchema = t.Object(
  {
    firstName: t.Optional(nameSchema),
    lastName: t.Optional(nameSchema),
    bio: t.Optional(t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' })),
    telephone: t.Optional(t.String({ pattern: '^0[0-9]{9}$', example: '0800000000' })),
    departmentId: t.Optional(t.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);

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
    department: t.Nullable(departmentSchema),
    avatar: t.Nullable(avatarSchema),
  }),
});
