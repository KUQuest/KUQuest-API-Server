import { t } from 'elysia';

const majorSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String({ example: 'Computer Engineering' }),
  faculty: t.Object({
    id: t.String({ format: 'uuid' }),
    name: t.String({ example: 'Engineering' }),
  }),
});

// A value may be replaced but never cleared, so every editable field has to reject
// what amounts to erasing it: `pattern: '\\S'` turns away whitespace-only input,
// which minLength alone accepts.
const nameSchema = t.String({ minLength: 1, maxLength: 100, pattern: '\\S' });

export const profileUpdateSchema = t.Object(
  {
    firstName: t.Optional(nameSchema),
    lastName: t.Optional(nameSchema),
    bio: t.Optional(t.String({ minLength: 1, maxLength: 500, pattern: '\\S' })),
    telephone: t.Optional(t.String({ pattern: '^0[0-9]{9}$', example: '0800000000' })),
    majorId: t.Optional(t.String({ format: 'uuid' })),
  },
  { additionalProperties: false },
);

export const profileUpdateResponseSchema = t.Object({
  success: t.Literal(true),
});

const editableFields = new Set(Object.keys(profileUpdateSchema.properties));

// Elysia strips body properties the schema does not declare rather than rejecting
// them, so writing a field this endpoint does not own would otherwise look like it
// succeeded. `normalize: false` would fix it, but only from the root application,
// where it would change every other module's behaviour too.
export const unknownProfileField = (body: unknown) => {
  if (!body || typeof body !== 'object') return undefined;

  return Object.keys(body).find((field) => !editableFields.has(field));
};

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
