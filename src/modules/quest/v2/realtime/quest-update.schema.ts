import { Value } from '@sinclair/typebox/value';
import { t } from 'elysia';

export const questUpdateParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

const questUpdateOtherChangeTypeSchema = t.Union([
  t.Literal('ASSIGNMENT_ROSTER_UPDATED'),
  t.Literal('QUEST_STARTED'),
  t.Literal('PROOF_SUBMITTED'),
  t.Literal('PROOF_REVIEWED'),
  t.Literal('PROOF_AUTO_APPROVED'),
  t.Literal('COMPLETION_CONFIRMED'),
  t.Literal('QUEST_COMPLETED'),
  t.Literal('QUEST_FAILED'),
  t.Literal('QUEST_CANCELLED'),
]);

export const questUpdateChangeTypeSchema = t.Union([
  questUpdateOtherChangeTypeSchema,
  t.Literal('QUEST_EDIT_UPDATED'),
]);

const questUpdateNotificationFields = {
  questId: t.String({ format: 'uuid' }),
  recipientMemberIds: t.Array(t.String({ format: 'uuid' }), { uniqueItems: true }),
  closeMemberIds: t.Optional(t.Array(t.String({ format: 'uuid' }), { uniqueItems: true })),
};

export const questUpdateNotificationSchema = t.Union([
  t.Object(
    {
      ...questUpdateNotificationFields,
      changeType: t.Literal('QUEST_EDIT_UPDATED'),
      editRequestId: t.String({ format: 'uuid' }),
    },
    { additionalProperties: false }
  ),
  t.Object(
    {
      ...questUpdateNotificationFields,
      changeType: questUpdateOtherChangeTypeSchema,
    },
    { additionalProperties: false }
  ),
]);

export type QuestUpdateChangeType = typeof questUpdateChangeTypeSchema.static;
export type QuestUpdateNotification = typeof questUpdateNotificationSchema.static;
export type QuestUpdateAccess = { role: 'HIRER' | 'WORKER'; mode: 'LIVE' | 'PENDING_PROOF' };

export const parseQuestUpdateNotification = (
  payload: string
): QuestUpdateNotification | undefined => {
  try {
    const event: unknown = JSON.parse(payload);
    return Value.Check(questUpdateNotificationSchema, event)
      ? (event as QuestUpdateNotification)
      : undefined;
  } catch {
    return undefined;
  }
};
