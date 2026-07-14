import { t } from 'elysia';

export const developmentUserSummarySchema = t.Object({
  id: t.String(),
  user_id: t.String(),
  email: t.String({ format: 'email' }),
  name: t.String(),
  first_name: t.String(),
  last_name: t.String(),
});

export const developmentTestUserSchema = t.Composite([
  developmentUserSummarySchema,
  t.Object({
    created_by_user_id: t.String(),
    created_at: t.String({ format: 'date-time' }),
  }),
]);

export const developmentSessionContextSchema = t.Object({
  root_user: developmentUserSummarySchema,
  active_user: developmentUserSummarySchema,
  acting_as_test_user: t.Boolean(),
  actor_session_expires_at: t.Union([
    t.String({ format: 'date-time' }),
    t.Null(),
  ]),
});
