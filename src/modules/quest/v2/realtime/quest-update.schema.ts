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
  t.Literal('QUEST_OPEN_EDIT_UPDATED'),
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
export type QuestUpdateAccess = {
  role: 'HIRER' | 'WORKER' | 'PROSPECTIVE_WORKER';
  mode: 'LIVE' | 'PENDING_PROOF';
};
const candidateRosterHirerScopeSchema = t.Object(
  { kind: t.Literal('HIRER') },
  { additionalProperties: false }
);
const candidateRosterApplicationScopeSchema = t.Object(
  { kind: t.Literal('APPLICATION'), applicationId: t.String({ format: 'uuid' }) },
  { additionalProperties: false }
);
const candidateRosterTeamScopeSchema = t.Object(
  { kind: t.Literal('TEAM'), teamId: t.String({ format: 'uuid' }) },
  { additionalProperties: false }
);

const candidateRosterAudienceSchema = t.Union([
  candidateRosterHirerScopeSchema,
  candidateRosterApplicationScopeSchema,
  t.Object(
    {
      kind: t.Literal('TEAM'),
      teamId: t.String({ format: 'uuid' }),
      closeMemberIds: t.Optional(t.Array(t.String({ format: 'uuid' }), { uniqueItems: true })),
    },
    { additionalProperties: false }
  ),
  t.Object(
    { kind: t.Literal('QUEST'), closeAll: t.Literal(true) },
    { additionalProperties: false }
  ),
]);

export const candidateRosterScopeSchema = t.Union([
  candidateRosterHirerScopeSchema,
  candidateRosterApplicationScopeSchema,
  candidateRosterTeamScopeSchema,
]);
export const candidateRosterUpdateNotificationSchema = t.Object(
  {
    questId: t.String({ format: 'uuid' }),
    type: t.Literal('CANDIDATE_ROSTER_UPDATED'),
    audience: candidateRosterAudienceSchema,
  },
  { additionalProperties: false }
);
export const questRealtimeNotificationSchema = t.Union([
  questUpdateNotificationSchema,
  candidateRosterUpdateNotificationSchema,
]);

export type CandidateRosterScope = typeof candidateRosterScopeSchema.static;
export type CandidateRosterUpdateAudience = typeof candidateRosterAudienceSchema.static;
export type CandidateRosterUpdateNotification =
  typeof candidateRosterUpdateNotificationSchema.static;
export type QuestRealtimeNotification = typeof questRealtimeNotificationSchema.static;

export const parseQuestRealtimeNotification = (
  payload: string
): QuestRealtimeNotification | undefined => {
  try {
    const event: unknown = JSON.parse(payload);
    return Value.Check(questRealtimeNotificationSchema, event)
      ? (event as QuestRealtimeNotification)
      : undefined;
  } catch {
    return undefined;
  }
};
