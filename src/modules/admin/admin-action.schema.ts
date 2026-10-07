import { t } from 'elysia';

export const adminDecisionReasonTextSchema = t.Optional(
  t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description:
      'Optional Admin-only decision note. It does not replace the controlled reason code.',
  })
);
