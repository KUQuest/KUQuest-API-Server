import { Value } from '@sinclair/typebox/value';
import { t } from 'elysia';

export const adminUpdateSubjectTypeSchema = t.Union([
  t.Literal('QUEST'),
  t.Literal('DISPUTE_CASE'),
  t.Literal('REPORT_CASE'),
  t.Literal('CONDUCT_REPORT'),
  t.Literal('MEMBER'),
  t.Literal('WALLET'),
  t.Literal('PAYOUT'),
  t.Literal('TOP_UP'),
  t.Literal('ADMIN_ACTIVITY_LOG'),
]);

export const adminUpdateNotificationSchema = t.Object(
  {
    type: t.Literal('RESOURCE_UPDATED'),
    subjectType: adminUpdateSubjectTypeSchema,
    subjectId: t.String({ format: 'uuid' }),
  },
  { additionalProperties: false }
);

export type AdminUpdateSubjectType = typeof adminUpdateSubjectTypeSchema.static;
export type AdminUpdateNotification = typeof adminUpdateNotificationSchema.static;

export const parseAdminUpdateNotification = (
  payload: string
): AdminUpdateNotification | undefined => {
  try {
    const value: unknown = JSON.parse(payload);
    if (Value.Check(adminUpdateNotificationSchema, value)) return value;
  } catch {
    return undefined;
  }
  return undefined;
};
