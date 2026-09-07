import { t, type Static } from 'elysia';

import { questV2TeamStates } from './quest-v2.contract';

const teamState = t.Union(
  questV2TeamStates.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

const memberSchema = t.Object({
  memberId: t.String({ format: 'uuid' }),
  joinedAt: t.String({ format: 'date-time' }),
});

const teamNameSchema = t.String({ minLength: 1, maxLength: 100, pattern: '\\S' });

const submissionSchema = t.Object({
  text: t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
  fileIds: t.Array(t.String({ format: 'uuid' }), { minItems: 1, uniqueItems: true }),
  submittedAt: t.String({ format: 'date-time' }),
});

const teamSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  leaderId: t.String({ format: 'uuid' }),
  name: teamNameSchema,
  headcount: t.Integer({ minimum: 2, maximum: 20 }),
  state: teamState,
  joinCode: t.Nullable(t.String({ pattern: '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$' })),
  joinCodeExpiresAt: t.Nullable(t.String({ format: 'date-time' })),
  members: t.Array(memberSchema),
  submission: t.Nullable(submissionSchema),
  createdAt: t.String({ format: 'date-time' }),
});

export const questV2CandidateTeamParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2CandidateTeamDetailParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  teamId: t.String({ format: 'uuid' }),
});

export const questV2CandidateTeamMemberParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  teamId: t.String({ format: 'uuid' }),
  memberId: t.String({ format: 'uuid' }),
});

export const questV2CandidateTeamHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe Candidate Team commands',
  }),
});

export const questV2CandidateTeamCreateSchema = t.Object({
  name: teamNameSchema,
  headcount: t.Integer({ minimum: 2, maximum: 20 }),
}, { additionalProperties: false });

export const questV2CandidateTeamUpdateSchema = t.Object({
  name: teamNameSchema,
}, { additionalProperties: false });

export const questV2CandidateTeamJoinSchema = t.Object({
  joinCode: t.String({ minLength: 1, maxLength: 32, pattern: '\\S' }),
}, { additionalProperties: false });

export const questV2CandidateTeamSubmissionSchema = t.Object({
  text: t.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
  fileIds: t.Array(t.String({ format: 'uuid' }), { minItems: 1, uniqueItems: true }),
}, { additionalProperties: false });

export const questV2CandidateTeamResponseSchema = t.Object({
  success: t.Literal(true),
  data: teamSchema,
});

export const questV2CandidateTeamListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ items: t.Array(teamSchema) }),
});

export type QuestV2CandidateTeamParams = Static<typeof questV2CandidateTeamParamsSchema>;
export type QuestV2CandidateTeamDetailParams = Static<typeof questV2CandidateTeamDetailParamsSchema>;
export type QuestV2CandidateTeamMemberParams = Static<typeof questV2CandidateTeamMemberParamsSchema>;
export type QuestV2CandidateTeamCreateInput = Static<typeof questV2CandidateTeamCreateSchema>;
export type QuestV2CandidateTeamUpdateInput = Static<typeof questV2CandidateTeamUpdateSchema>;
export type QuestV2CandidateTeamJoinInput = Static<typeof questV2CandidateTeamJoinSchema>;
export type QuestV2CandidateTeamSubmissionInput = Static<typeof questV2CandidateTeamSubmissionSchema>;
