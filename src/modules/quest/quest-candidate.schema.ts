import { t } from 'elysia';

import { applicationStatuses, assignmentStatuses, invitationStatuses, questStatuses, teamStatuses } from './quest.contract';

const status = (values: readonly string[]) => t.Union(values.map((value) => t.Literal(value)) as [ReturnType<typeof t.Literal<string>>, ...ReturnType<typeof t.Literal<string>>[]]);

export const applicationParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }) });
export const applicationDetailParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), applicationId: t.String({ format: 'uuid' }) });
export const applicationCreateSchema = t.Object({ reworkLimit: t.Optional(t.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const applicationUpdateSchema = t.Object({ reworkLimit: t.Integer({ minimum: 0 }) }, { additionalProperties: false });

const applicationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.String({ format: 'uuid' }),
  applicationStatus: status(applicationStatuses),
  reworkLimit: t.Integer({ minimum: 0 }),
  appliedAt: t.String({ format: 'date-time' }),
});
export const applicationResponseSchema = t.Object({ success: t.Literal(true), data: applicationSchema });
export const applicationListResponseSchema = t.Object({ success: t.Literal(true), data: t.Object({ items: t.Array(applicationSchema) }) });

export const teamParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }) });
export const teamDetailParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), teamId: t.String({ format: 'uuid' }) });
export const teamMemberParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), teamId: t.String({ format: 'uuid' }), memberId: t.String({ format: 'uuid' }) });
export const teamCreateSchema = t.Object({ name: t.String({ minLength: 1, maxLength: 100, pattern: '\\S' }), reworkLimit: t.Optional(t.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const teamUpdateSchema = t.Object({ name: t.Optional(t.String({ minLength: 1, maxLength: 100, pattern: '\\S' })), reworkLimit: t.Optional(t.Integer({ minimum: 0 })) }, { additionalProperties: false });

const memberSchema = t.Object({ userId: t.String({ format: 'uuid' }), joinedAt: t.String({ format: 'date-time' }) });
const teamSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  leaderId: t.String({ format: 'uuid' }),
  name: t.String(),
  teamStatus: status(teamStatuses),
  reworkLimit: t.Integer({ minimum: 0 }),
  createdAt: t.String({ format: 'date-time' }),
  members: t.Array(memberSchema),
});
export const teamResponseSchema = t.Object({ success: t.Literal(true), data: teamSchema });
export const teamListResponseSchema = t.Object({ success: t.Literal(true), data: t.Object({ items: t.Array(teamSchema) }) });
export const teamMembersResponseSchema = t.Object({ success: t.Literal(true), data: t.Object({ items: t.Array(memberSchema) }) });

export const invitationParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), teamId: t.String({ format: 'uuid' }) });
export const invitationDetailParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), teamId: t.String({ format: 'uuid' }), invitationId: t.String({ format: 'uuid' }) });
export const ownInvitationParamsSchema = t.Object({ invitationId: t.String({ format: 'uuid' }) });
export const invitationCreateSchema = t.Object({ invitedUserId: t.String({ format: 'uuid' }) }, { additionalProperties: false });
const invitationSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  teamId: t.String({ format: 'uuid' }),
  invitedUserId: t.String({ format: 'uuid' }),
  invitedByUserId: t.String({ format: 'uuid' }),
  invitationStatus: status(invitationStatuses),
  createdAt: t.String({ format: 'date-time' }),
  respondedAt: t.Nullable(t.String({ format: 'date-time' })),
  expiresAt: t.String({ format: 'date-time' }),
});
export const invitationResponseSchema = t.Object({ success: t.Literal(true), data: invitationSchema });
export const invitationListResponseSchema = t.Object({ success: t.Literal(true), data: t.Object({ items: t.Array(invitationSchema) }) });

const assignmentStatus = status(assignmentStatuses);
const questStatus = status(questStatuses);
const selectionAssignmentSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.String({ format: 'uuid' }),
  assignmentStatus,
  startedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
});
export const candidateSelectionHeadersSchema = t.Object({
  'idempotency-key': t.String({ minLength: 1, maxLength: 200, pattern: '\\S', description: 'Non-blank command identity for replay-safe Candidate selection' }),
});
export const candidateSelectionApplicationParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), applicationId: t.String({ format: 'uuid' }) });
export const candidateSelectionTeamParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), teamId: t.String({ format: 'uuid' }) });
export const candidateSelectionResponseSchema = t.Object({ success: t.Literal(true), data: t.Object({ assignments: t.Array(selectionAssignmentSchema), questStatus }) });

export type ApplicationCreateInput = typeof applicationCreateSchema.static;
export type ApplicationUpdateInput = typeof applicationUpdateSchema.static;
export type TeamCreateInput = typeof teamCreateSchema.static;
export type TeamUpdateInput = typeof teamUpdateSchema.static;
export type InvitationCreateInput = typeof invitationCreateSchema.static;

