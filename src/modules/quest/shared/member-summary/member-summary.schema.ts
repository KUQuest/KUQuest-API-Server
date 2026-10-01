import { profileAvatarSchema } from '@/modules/profile/profile.schema';

import { t } from 'elysia';

/** Public-profile subset embedded next to every Member ID in Quest responses. */
export const memberSummarySchema = t.Object({
  id: t.String({ format: 'uuid' }),
  displayName: t.String({ minLength: 1, pattern: '\\S' }),
  avatar: profileAvatarSchema,
  faculty: t.Optional(t.Nullable(t.String())),
  department: t.Optional(t.Nullable(t.String())),
  ratingAverage: t.Optional(t.Nullable(t.Number({ minimum: 1, maximum: 5 }))),
});
