import { t } from 'elysia';

export const certificateParamsSchema = t.Object({
  certificateId: t.String({
    format: 'uuid',
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  }),
});

export const certificateCreateSchema = t.Object(
  {
    name: t.String({
      minLength: 1,
      example: 'AWS Certified Cloud Practitioner',
      error: 'Certificate name is required',
    }),
    issuer: t.String({
      minLength: 1,
      example: 'Amazon Web Services',
      error: 'Certificate issuer is required',
    }),
    issuedAt: t.String({
      format: 'date',
      example: '2024-05-01',
      error: 'Issue date must be a calendar date in YYYY-MM-DD format',
    }),
    verifyUrl: t.Optional(
      t.Nullable(
        t.String({
          format: 'uri',
          example: 'https://verify.example.com/abc123',
          error: 'Verification link must be a valid URL',
        }),
      ),
    ),
  },
  { additionalProperties: false },
);

// Every field optional so a caller may patch a subset; each supplied field is
// still validated by the create schema's rules.
export const certificateUpdateSchema = t.Partial(certificateCreateSchema);

const certificateSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  name: t.String(),
  issuer: t.String(),
  issuedAt: t.String({ format: 'date' }),
  verifyUrl: t.Nullable(t.String()),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
});

export const certificateResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ certificate: certificateSchema }),
});

export const certificateListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ certificates: t.Array(certificateSchema) }),
});
