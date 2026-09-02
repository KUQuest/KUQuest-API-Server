import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questApiVersion,
  questApplication,
  questAssignment,
  questCandidateSelectionCommand,
  questTeam,
  questTeamInvitation,
  questTeamMember,
} from '@/database/schema/quest.schema';

import { and, asc, eq, exists, inArray, or, sql } from 'drizzle-orm';

import {
  getQuestWorkChatMembershipWriter,
  WorkChatTransitionError,
  type QuestTransaction,
} from './quest-assignment.service';
import type {
  AcceptedWorker,
  WorkChatMembershipWriter,
  QuestWorkChatMembershipTransition,
} from './quest-work-chat.contract';

import { applicationStatus, assignmentStatus, questMode, questParticipation, questStatus, teamStatus } from './quest.contract';
import type {
  ApplicationCreateInput,
  ApplicationUpdateInput,
  InvitationCreateInput,
  TeamCreateInput,
  TeamUpdateInput,
} from './quest-candidate.schema';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Tx;

const applicationFields = {
  id: questApplication.id,
  questId: questApplication.questId,
  workerId: questApplication.workerId,
  applicationStatus: questApplication.applicationStatus,
  reworkLimit: questApplication.reworkLimit,
  appliedAt: questApplication.appliedAt,
};
const teamFields = {
  id: questTeam.id,
  questId: questTeam.questId,
  leaderId: questTeam.leaderId,
  name: questTeam.name,
  teamStatus: questTeam.teamStatus,
  reworkLimit: questTeam.reworkLimit,
  createdAt: questTeam.createdAt,
};
const invitationFields = {
  id: questTeamInvitation.id,
  teamId: questTeamInvitation.teamId,
  invitedUserId: questTeamInvitation.invitedUserId,
  invitedByUserId: questTeamInvitation.invitedByUserId,
  invitationStatus: questTeamInvitation.invitationStatus,
  createdAt: questTeamInvitation.createdAt,
  respondedAt: questTeamInvitation.respondedAt,
  expiresAt: questTeamInvitation.expiresAt,
};

type ApplicationRecord = {
  id: string;
  questId: string;
  workerId: string;
  applicationStatus: string;
  reworkLimit: number;
  appliedAt: Date;
};
type TeamRecord = {
  id: string;
  questId: string;
  leaderId: string;
  name: string;
  teamStatus: string;
  reworkLimit: number;
  createdAt: Date;
};
type TeamMemberRecord = { userId: string; joinedAt: Date };
type TeamWithMembers = TeamRecord & { members: TeamMemberRecord[] };

export type CandidateOutcome =
  | { outcome: 'not-found' | 'not-eligible' | 'already-exists' | 'not-authorized' | 'not-editable' | 'not-withdrawable' }
  | { id: string; questId: string; workerId: string; applicationStatus: string; reworkLimit: number; appliedAt: Date };

const applicationResult = (row: typeof applicationFields extends never ? never : {
  id: string; questId: string; workerId: string; applicationStatus: string; reworkLimit: number; appliedAt: Date;
}) => row;

const lockQuest = async (tx: Tx, questId: string) => {
  const [row] = await tx.select({
    id: quest.id,
    hirerId: quest.hirerId,
    mode: quest.mode,
    participation: quest.participation,
    questStatus: quest.questStatus,
    headcount: quest.headcount,
    hiddenAt: quest.hiddenAt,
  }).from(quest).where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v1))).limit(1).for('update');
  return row;
};

export const createApplication = async (workerId: string, questId: string, data: ApplicationCreateInput, now = new Date()): Promise<CandidateOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  // A hidden Quest is out of reach for Members, so it refuses an application the same
  // way a Quest that is not open does.
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.solo || current.questStatus !== questStatus.open || current.hiddenAt !== null || current.hirerId === workerId) return { outcome: 'not-eligible' };
  const [existing] = await tx.select({ id: questApplication.id }).from(questApplication).where(and(eq(questApplication.questId, questId), eq(questApplication.workerId, workerId))).limit(1);
  if (existing) return { outcome: 'already-exists' };
  const [row] = await tx.insert(questApplication).values({ questId, workerId, reworkLimit: data.reworkLimit ?? 0, appliedAt: now }).returning(applicationFields);
  return applicationResult(row);
});

export const getApplication = async (userId: string, questId: string, applicationId: string) => {
  const [row] = await db.select(applicationFields).from(questApplication).innerJoin(quest, eq(questApplication.questId, quest.id)).where(and(eq(questApplication.id, applicationId), eq(questApplication.questId, questId), eq(quest.apiVersion, questApiVersion.v1), eq(quest.mode, questMode.candidate), eq(quest.participation, questParticipation.solo), eq(quest.questStatus, questStatus.open), or(eq(questApplication.workerId, userId), eq(quest.hirerId, userId)))).limit(1);
  return row;
};

export type ApplicationCollection = { outcome: 'not-found' } | ApplicationRecord[];

export const listApplications = async (userId: string, questId: string): Promise<ApplicationCollection> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.solo || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  return tx.select(applicationFields).from(questApplication).innerJoin(quest, eq(questApplication.questId, quest.id)).where(and(eq(questApplication.questId, questId), eq(quest.apiVersion, questApiVersion.v1), eq(quest.mode, questMode.candidate), eq(quest.participation, questParticipation.solo), eq(quest.questStatus, questStatus.open), or(eq(questApplication.workerId, userId), eq(quest.hirerId, userId)))).orderBy(asc(questApplication.appliedAt), asc(questApplication.id));
});

export const updateApplication = async (userId: string, questId: string, applicationId: string, data: ApplicationUpdateInput): Promise<CandidateOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.solo || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  const [row] = await tx.select(applicationFields).from(questApplication).where(and(eq(questApplication.id, applicationId), eq(questApplication.questId, questId), eq(questApplication.workerId, userId))).limit(1).for('update');
  if (!row) return { outcome: 'not-authorized' };
  if (row.applicationStatus !== applicationStatus.applied) return { outcome: 'not-editable' };
  const [updated] = await tx.update(questApplication).set({ reworkLimit: data.reworkLimit }).where(eq(questApplication.id, applicationId)).returning(applicationFields);
  return applicationResult(updated);
});

export const withdrawApplication = async (userId: string, questId: string, applicationId: string): Promise<CandidateOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.solo || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  const [row] = await tx.select(applicationFields).from(questApplication).where(and(eq(questApplication.id, applicationId), eq(questApplication.questId, questId), eq(questApplication.workerId, userId))).limit(1).for('update');
  if (!row) return { outcome: 'not-authorized' };
  if (row.applicationStatus !== applicationStatus.applied) return { outcome: 'not-withdrawable' };
  const [updated] = await tx.update(questApplication).set({ applicationStatus: applicationStatus.withdrawn }).where(eq(questApplication.id, applicationId)).returning(applicationFields);
  return applicationResult(updated);
});

const memberRows = async (database: Database, teamId: string) => database.select({ userId: questTeamMember.userId, joinedAt: questTeamMember.joinedAt }).from(questTeamMember).where(eq(questTeamMember.teamId, teamId)).orderBy(asc(questTeamMember.joinedAt), asc(questTeamMember.userId));
const withMembers = async (database: Database, row: TeamRecord): Promise<TeamWithMembers> => ({ ...row, members: await memberRows(database, row.id) });

export type TeamOutcome =
  | { outcome: 'not-found' | 'not-eligible' | 'already-exists' | 'not-authorized' | 'not-editable' | 'headcount-mismatch' | 'leader-removal-not-allowed' }
  | Awaited<ReturnType<typeof withMembers>>;

const ensureNoMembership = async (tx: Tx, questId: string, userId: string) => {
  const [row] = await tx.select({ id: questTeamMember.teamId }).from(questTeamMember).innerJoin(questTeam, eq(questTeamMember.teamId, questTeam.id)).where(and(eq(questTeam.questId, questId), eq(questTeamMember.userId, userId))).limit(1);
  return !row;
};

const teamMemberAccess = (userId: string) => exists(sql`(
  select 1
  from quest_team_member m
  where m.team_id = ${questTeam.id}
    and m.user_id = ${userId}
)`);

const teamAccess = (userId: string) => or(eq(quest.hirerId, userId), teamMemberAccess(userId));

export const createTeam = async (leaderId: string, questId: string, data: TeamCreateInput, now = new Date()): Promise<TeamOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  // A hidden Quest is out of reach for Members, so it refuses a Team the same way a
  // Quest that is not open does.
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.group || current.questStatus !== questStatus.open || current.hiddenAt !== null || current.hirerId === leaderId) return { outcome: 'not-eligible' };
  if (!(await ensureNoMembership(tx, questId, leaderId))) return { outcome: 'already-exists' };
  const [team] = await tx.insert(questTeam).values({ questId, leaderId, name: data.name, reworkLimit: data.reworkLimit ?? 0, createdAt: now }).returning(teamFields);
  await tx.insert(questTeamMember).values({ teamId: team.id, userId: leaderId, joinedAt: now });
  return withMembers(tx, team);
});

const selectTeamForUser = async (database: Database, userId: string, questId: string, teamId: string, lock = false) => {
  const query = database.select(teamFields).from(questTeam).innerJoin(quest, eq(questTeam.questId, quest.id)).where(and(eq(questTeam.id, teamId), eq(questTeam.questId, questId), eq(quest.apiVersion, questApiVersion.v1), eq(quest.mode, questMode.candidate), eq(quest.participation, questParticipation.group), eq(quest.questStatus, questStatus.open), sql`${questTeam.teamStatus} <> ${teamStatus.disbanded}`, teamAccess(userId))).limit(1);
  return (lock ? await query.for('update') : await query)[0];
};

export const getTeam = async (userId: string, questId: string, teamId: string) => {
  const row = await selectTeamForUser(db, userId, questId, teamId);
  return row ? withMembers(db, row) : undefined;
};

export type TeamCollection = { outcome: 'not-found' } | TeamWithMembers[];

export const listTeams = async (userId: string, questId: string): Promise<TeamCollection> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.group || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  const rows = await tx.select(teamFields).from(questTeam).innerJoin(quest, eq(questTeam.questId, quest.id)).where(and(eq(questTeam.questId, questId), eq(quest.apiVersion, questApiVersion.v1), eq(quest.mode, questMode.candidate), eq(quest.participation, questParticipation.group), eq(quest.questStatus, questStatus.open), sql`${questTeam.teamStatus} <> ${teamStatus.disbanded}`, teamAccess(userId))).orderBy(asc(questTeam.createdAt), asc(questTeam.id));
  return Promise.all(rows.map((row) => withMembers(tx, row)));
});

export const updateTeam = async (userId: string, questId: string, teamId: string, data: TeamUpdateInput): Promise<TeamOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-found' };
  const row = await selectTeamForUser(tx, userId, questId, teamId, true);
  if (!row) return { outcome: 'not-found' };
  if (row.leaderId !== userId) return { outcome: 'not-authorized' };
  if (row.teamStatus !== teamStatus.forming) return { outcome: 'not-editable' };
  if (data.name === undefined && data.reworkLimit === undefined) return { outcome: 'not-editable' };
  const [updated] = await tx.update(questTeam).set({ ...(data.name !== undefined ? { name: data.name } : {}), ...(data.reworkLimit !== undefined ? { reworkLimit: data.reworkLimit } : {}) }).where(eq(questTeam.id, teamId)).returning(teamFields);
  return withMembers(tx, updated);
});

export const listTeamMembers = async (userId: string, questId: string, teamId: string) => {
  const row = await selectTeamForUser(db, userId, questId, teamId);
  return row ? memberRows(db, teamId) : undefined;
};

const lockTeamMembers = async (tx: Tx, teamId: string) => tx
  .select({ userId: questTeamMember.userId, joinedAt: questTeamMember.joinedAt })
  .from(questTeamMember)
  .where(eq(questTeamMember.teamId, teamId))
  .orderBy(asc(questTeamMember.joinedAt), asc(questTeamMember.userId))
  .for('update');

const revokePendingTeamInvitations = async (tx: Tx, teamId: string, now: Date) => {
  await tx
    .update(questTeamInvitation)
    .set({ invitationStatus: 'INVITATION_REVOKED', respondedAt: now })
    .where(and(eq(questTeamInvitation.teamId, teamId), eq(questTeamInvitation.invitationStatus, 'INVITATION_PENDING')));
};

export const leaveTeam = async (userId: string, questId: string, teamId: string, now = new Date()): Promise<TeamOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.group || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  const [row] = await tx.select(teamFields).from(questTeam).where(and(eq(questTeam.id, teamId), eq(questTeam.questId, questId))).limit(1).for('update');
  if (!row || row.teamStatus === teamStatus.disbanded) return { outcome: 'not-found' };
  if (row.teamStatus !== teamStatus.forming) return { outcome: 'not-editable' };
  const members = await lockTeamMembers(tx, teamId);
  if (!members.some((member) => member.userId === userId)) return { outcome: 'not-found' };

  await tx.delete(questTeamMember).where(and(eq(questTeamMember.teamId, teamId), eq(questTeamMember.userId, userId)));
  const remaining = members.filter((member) => member.userId !== userId);
  if (remaining.length === 0) {
    await revokePendingTeamInvitations(tx, teamId, now);
    const [updated] = await tx.update(questTeam).set({ teamStatus: teamStatus.disbanded }).where(eq(questTeam.id, teamId)).returning(teamFields);
    return withMembers(tx, updated);
  }

  if (row.leaderId !== userId) return withMembers(tx, row);
  const [updated] = await tx.update(questTeam).set({ leaderId: remaining[0]!.userId }).where(eq(questTeam.id, teamId)).returning(teamFields);
  return withMembers(tx, updated);
});

export const removeTeamMember = async (leaderId: string, questId: string, teamId: string, memberId: string): Promise<TeamOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.group || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  const row = await selectTeamForUser(tx, leaderId, questId, teamId, true);
  if (!row) return { outcome: 'not-found' };
  if (row.leaderId !== leaderId) return { outcome: 'not-authorized' };
  if (row.teamStatus !== teamStatus.forming) return { outcome: 'not-editable' };
  if (memberId === leaderId) return { outcome: 'leader-removal-not-allowed' };
  const members = await lockTeamMembers(tx, teamId);
  if (!members.some((member) => member.userId === memberId)) return { outcome: 'not-found' };
  await tx.delete(questTeamMember).where(and(eq(questTeamMember.teamId, teamId), eq(questTeamMember.userId, memberId)));
  return withMembers(tx, row);
});

export const submitTeam = async (userId: string, questId: string, teamId: string): Promise<TeamOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.group || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  const row = await selectTeamForUser(tx, userId, questId, teamId, true);
  if (!row) return { outcome: 'not-found' };
  if (row.leaderId !== userId) return { outcome: 'not-authorized' };
  if (row.teamStatus !== teamStatus.forming) return { outcome: 'not-editable' };
  const members = await tx.select({ userId: questTeamMember.userId }).from(questTeamMember).where(eq(questTeamMember.teamId, teamId));
  if (members.length !== current.headcount) return { outcome: 'headcount-mismatch' };
  const [updated] = await tx.update(questTeam).set({ teamStatus: teamStatus.submitted }).where(and(eq(questTeam.id, teamId), eq(questTeam.teamStatus, teamStatus.forming))).returning(teamFields);
  return withMembers(tx, updated);
});

export type InvitationOutcome =
  | { outcome: 'not-found' | 'not-authorized' | 'not-eligible' | 'already-pending' | 'already-member' | 'expired' | 'not-actionable' }
  | Awaited<ReturnType<typeof invitationResult>>;
const invitationResult = (row: { id: string; teamId: string; invitedUserId: string; invitedByUserId: string; invitationStatus: string; createdAt: Date; respondedAt: Date | null; expiresAt: Date }) => row;

const selectInvitation = async (database: Database, questId: string, teamId: string, invitationId: string, lock = false) => {
  const query = database.select(invitationFields).from(questTeamInvitation).innerJoin(questTeam, eq(questTeamInvitation.teamId, questTeam.id)).where(and(eq(questTeamInvitation.id, invitationId), eq(questTeamInvitation.teamId, teamId), eq(questTeam.questId, questId))).limit(1);
  return (lock ? await query.for('update') : await query)[0];
};

export const createInvitation = async (leaderId: string, questId: string, teamId: string, data: InvitationCreateInput, now = new Date()): Promise<InvitationOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.group || current.questStatus !== questStatus.open) return { outcome: 'not-found' };
  const team = await selectTeamForUser(tx, leaderId, questId, teamId, true);
  if (!team || team.leaderId !== leaderId || team.teamStatus !== teamStatus.forming || data.invitedUserId === leaderId || data.invitedUserId === current.hirerId) return { outcome: 'not-eligible' };
  const [pending] = await tx.select({ id: questTeamInvitation.id }).from(questTeamInvitation).where(and(eq(questTeamInvitation.teamId, teamId), eq(questTeamInvitation.invitedUserId, data.invitedUserId), eq(questTeamInvitation.invitationStatus, 'INVITATION_PENDING'))).limit(1);
  if (pending) return { outcome: 'already-pending' };
  const [invitedUser] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, data.invitedUserId)).limit(1);
  if (!invitedUser) return { outcome: 'not-eligible' };
  if (!(await ensureNoMembership(tx, questId, data.invitedUserId))) return { outcome: 'already-member' };
  const [created] = await tx.insert(questTeamInvitation).values({ teamId, invitedUserId: data.invitedUserId, invitedByUserId: leaderId, createdAt: now, expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) }).returning(invitationFields);
  return invitationResult(created);
});

export const listTeamInvitations = async (leaderId: string, questId: string, teamId: string) => {
  const team = await selectTeamForUser(db, leaderId, questId, teamId);
  if (!team || team.leaderId !== leaderId) return undefined;
  return db.select(invitationFields).from(questTeamInvitation).where(and(eq(questTeamInvitation.teamId, teamId), eq(questTeamInvitation.invitationStatus, 'INVITATION_PENDING'))).orderBy(asc(questTeamInvitation.createdAt), asc(questTeamInvitation.id));
};

export const listOwnInvitations = async (userId: string) => db.select(invitationFields).from(questTeamInvitation).innerJoin(questTeam, eq(questTeamInvitation.teamId, questTeam.id)).innerJoin(quest, eq(questTeam.questId, quest.id)).where(and(eq(questTeamInvitation.invitedUserId, userId), eq(quest.apiVersion, questApiVersion.v1), eq(quest.mode, questMode.candidate), eq(quest.participation, questParticipation.group), eq(quest.questStatus, questStatus.open), sql`${questTeam.teamStatus} <> ${teamStatus.disbanded}`)).orderBy(asc(questTeamInvitation.createdAt), asc(questTeamInvitation.id));

export const revokeInvitation = async (leaderId: string, questId: string, teamId: string, invitationId: string, now = new Date()): Promise<InvitationOutcome> => db.transaction(async (tx) => {
  const current = await lockQuest(tx, questId);
  if (!current) return { outcome: 'not-found' };
  const team = await selectTeamForUser(tx, leaderId, questId, teamId, true);
  if (!team || team.leaderId !== leaderId) return { outcome: 'not-authorized' };
  if (team.teamStatus !== teamStatus.forming) return { outcome: 'not-actionable' };
  const row = await selectInvitation(tx, questId, teamId, invitationId, true);
  if (!row) return { outcome: 'not-found' };
  if (row.invitationStatus !== 'INVITATION_PENDING') return { outcome: 'not-actionable' };
  const [updated] = await tx.update(questTeamInvitation).set({ invitationStatus: 'INVITATION_REVOKED', respondedAt: now }).where(eq(questTeamInvitation.id, invitationId)).returning(invitationFields);
  return invitationResult(updated);
});

const respondToInvitation = async (userId: string, invitationId: string, response: 'INVITATION_ACCEPTED' | 'INVITATION_DECLINED', now: Date): Promise<InvitationOutcome> => db.transaction(async (tx) => {
  const [identity] = await tx.select({ questId: questTeam.questId, teamId: questTeam.id }).from(questTeamInvitation).innerJoin(questTeam, eq(questTeamInvitation.teamId, questTeam.id)).where(and(eq(questTeamInvitation.id, invitationId), eq(questTeamInvitation.invitedUserId, userId))).limit(1);
  if (!identity) return { outcome: 'not-found' };
  const current = await lockQuest(tx, identity.questId);
  // A hidden Quest is out of reach for Members, so it refuses an invitation response
  // the same way a Quest that is not open does.
  if (!current || current.mode !== questMode.candidate || current.participation !== questParticipation.group || current.questStatus !== questStatus.open || current.hiddenAt !== null) return { outcome: 'not-eligible' };
  const team = await tx.select(teamFields).from(questTeam).where(eq(questTeam.id, identity.teamId)).limit(1).for('update');
  if (!team[0]) return { outcome: 'not-found' };
  const row = await tx.select(invitationFields).from(questTeamInvitation).where(eq(questTeamInvitation.id, invitationId)).limit(1).for('update');
  if (!row[0]) return { outcome: 'not-found' };
  if (row[0].invitationStatus !== 'INVITATION_PENDING') return { outcome: 'not-actionable' };
  if (row[0].expiresAt.getTime() <= now.getTime()) return { outcome: 'expired' };
  if (team[0].teamStatus !== teamStatus.forming) return { outcome: 'not-eligible' };
  if (response === 'INVITATION_DECLINED') {
    const [updated] = await tx.update(questTeamInvitation).set({ invitationStatus: response, respondedAt: now }).where(eq(questTeamInvitation.id, invitationId)).returning(invitationFields);
    return invitationResult(updated);
  }
  if (!(await ensureNoMembership(tx, identity.questId, userId))) return { outcome: 'already-member' };
  await tx.insert(questTeamMember).values({ teamId: identity.teamId, userId, joinedAt: now });
  const [updated] = await tx.update(questTeamInvitation).set({ invitationStatus: response, respondedAt: now }).where(eq(questTeamInvitation.id, invitationId)).returning(invitationFields);
  return invitationResult(updated);
});

export const acceptInvitation = (userId: string, invitationId: string, now = new Date()) => respondToInvitation(userId, invitationId, 'INVITATION_ACCEPTED', now);
export const declineInvitation = (userId: string, invitationId: string, now = new Date()) => respondToInvitation(userId, invitationId, 'INVITATION_DECLINED', now);
export const getOwnInvitation = async (userId: string, invitationId: string) => db.select(invitationFields).from(questTeamInvitation).innerJoin(questTeam, eq(questTeamInvitation.teamId, questTeam.id)).innerJoin(quest, eq(questTeam.questId, quest.id)).where(and(eq(questTeamInvitation.id, invitationId), eq(questTeamInvitation.invitedUserId, userId), eq(quest.apiVersion, questApiVersion.v1), eq(quest.mode, questMode.candidate), eq(quest.participation, questParticipation.group), eq(quest.questStatus, questStatus.open), sql`${questTeam.teamStatus} <> ${teamStatus.disbanded}`)).limit(1).then(([row]) => row);

export type CandidateSelectionTarget =
  | { type: 'APPLICATION'; id: string }
  | { type: 'TEAM'; id: string };

type SelectionAssignment = {
  id: string;
  questId: string;
  workerId: string;
  assignmentStatus: string;
  startedAt: Date | null;
  createdAt: Date;
};

type SelectionOutcomeCode = 'not-found' | 'application-not-found' | 'team-not-found' | 'not-open' | 'not-allowed' | 'not-selectable' | 'headcount-mismatch' | 'already-assigned' | 'idempotency-key-required' | 'idempotency-key-reused' | 'idempotency-unavailable';
export type CandidateSelectionOutcome =
  | { outcome: SelectionOutcomeCode }
  | { assignments: SelectionAssignment[]; questStatus: typeof questStatus.assigned };

export type CandidateSelectionOptions = {
  commandId: string;
  now?: Date;
  workChatWriter?: WorkChatMembershipWriter<QuestTransaction>;
};

const selectionAssignmentFields = {
  id: questAssignment.id,
  questId: questAssignment.questId,
  workerId: questAssignment.workerId,
  assignmentStatus: questAssignment.assignmentStatus,
  startedAt: questAssignment.startedAt,
  createdAt: questAssignment.createdAt,
};

const selectionCommandFields = {
  id: questCandidateSelectionCommand.id,
  commandId: questCandidateSelectionCommand.commandId,
  hirerId: questCandidateSelectionCommand.hirerId,
  questId: questCandidateSelectionCommand.questId,
  targetType: questCandidateSelectionCommand.targetType,
  targetId: questCandidateSelectionCommand.targetId,
  requestHash: questCandidateSelectionCommand.requestHash,
  resultAssignmentIds: questCandidateSelectionCommand.resultAssignmentIds,
  resultQuestStatus: questCandidateSelectionCommand.resultQuestStatus,
  processingStatus: questCandidateSelectionCommand.processingStatus,
};

const hashSelectionRequest = async (hirerId: string, questId: string, target: CandidateSelectionTarget) => {
  const payload = JSON.stringify({ hirerId, questId, targetType: target.type, targetId: target.id });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

type SelectionCommandRecord = {
  hirerId: string;
  questId: string;
  targetType: string;
  targetId: string;
  requestHash: string;
  resultAssignmentIds: unknown;
  resultQuestStatus: string | null;
  processingStatus: string;
};

const replaySelection = async (tx: QuestTransaction, command: SelectionCommandRecord, hirerId: string, questId: string, target: CandidateSelectionTarget, requestHash: string): Promise<CandidateSelectionOutcome> => {
  if (command.hirerId !== hirerId || command.questId !== questId || command.targetType !== target.type || command.targetId !== target.id || command.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (command.processingStatus !== 'COMPLETED' || !Array.isArray(command.resultAssignmentIds) || command.resultQuestStatus !== questStatus.assigned) return { outcome: 'idempotency-unavailable' };
  const ids = command.resultAssignmentIds.filter((id): id is string => typeof id === 'string');
  const rows = await tx.select(selectionAssignmentFields).from(questAssignment).where(inArray(questAssignment.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const assignments = ids.map((id) => byId.get(id)).filter((row): row is SelectionAssignment => row !== undefined);
  if (assignments.length !== ids.length) return { outcome: 'idempotency-unavailable' };
  return { assignments, questStatus: questStatus.assigned };
};

const acquireSelectionCommand = async (
  tx: QuestTransaction,
  commandId: string,
  hirerId: string,
  questId: string,
  target: CandidateSelectionTarget,
  requestHash: string,
  now: Date,
) => {
  const [existing] = await tx.select(selectionCommandFields).from(questCandidateSelectionCommand).where(eq(questCandidateSelectionCommand.commandId, commandId)).limit(1).for('update');
  if (existing) return replaySelection(tx, existing, hirerId, questId, target, requestHash);
  const [created] = await tx.insert(questCandidateSelectionCommand).values({ commandId, hirerId, questId, targetType: target.type, targetId: target.id, requestHash, createdAt: now }).onConflictDoNothing({ target: questCandidateSelectionCommand.commandId }).returning(selectionCommandFields);
  if (created) return { created: true as const };
  const [concurrent] = await tx.select(selectionCommandFields).from(questCandidateSelectionCommand).where(eq(questCandidateSelectionCommand.commandId, commandId)).limit(1).for('update');
  return concurrent ? replaySelection(tx, concurrent, hirerId, questId, target, requestHash) : { outcome: 'idempotency-unavailable' as const };
};

const selectionTransition = (
  commandId: string,
  questId: string,
  hirerId: string,
  now: Date,
  assignments: SelectionAssignment[],
): QuestWorkChatMembershipTransition => {
  const workers = assignments.map((assignment) => ({ workerId: assignment.workerId, assignmentId: assignment.id, joinedAt: assignment.createdAt.toISOString() })) as [AcceptedWorker, ...AcceptedWorker[]];
  return { producer: 'QUEST_CANDIDATE_SELECTION', type: 'workersAccepted', commandId, eventId: commandId, questId, actorId: hirerId, hirerId, occurredAt: now.toISOString(), workers };
};

/** Select one submitted Candidate and fan out its accepted roster. */
export const selectCandidate = async (
  hirerId: string,
  questId: string,
  target: CandidateSelectionTarget,
  options: CandidateSelectionOptions,
): Promise<CandidateSelectionOutcome> => {
  const commandId = options.commandId.trim();
  if (!commandId) return { outcome: 'idempotency-key-required' };
  const now = options.now ?? new Date();
  const requestHash = await hashSelectionRequest(hirerId, questId, target);
  const writer = options.workChatWriter ?? getQuestWorkChatMembershipWriter();
  if (!writer) throw new WorkChatTransitionError(new Error('Work Chat membership writer is not configured'));

  return db.transaction(async (tx) => {
    const current = await lockQuest(tx, questId);
    if (!current) return { outcome: 'not-found' as const };
    const command = await acquireSelectionCommand(tx, commandId, hirerId, questId, target, requestHash, now);
    if ('outcome' in command || 'assignments' in command) return command;
    const discardCommand = async (outcome: SelectionOutcomeCode) => {
      await tx.delete(questCandidateSelectionCommand).where(eq(questCandidateSelectionCommand.commandId, commandId));
      return { outcome } as const;
    };
    if (current.hirerId !== hirerId) return discardCommand('not-allowed');
    if (current.questStatus !== questStatus.open) return discardCommand('not-open');
    if (current.mode !== questMode.candidate || (target.type === 'APPLICATION' && current.participation !== questParticipation.solo) || (target.type === 'TEAM' && current.participation !== questParticipation.group)) return discardCommand('not-allowed');

    const assignmentRows = await tx.select(selectionAssignmentFields).from(questAssignment).where(eq(questAssignment.questId, questId)).for('update');
    const roster: string[] = [];
    if (target.type === 'APPLICATION') {
      const candidates = await tx.select(applicationFields).from(questApplication).where(eq(questApplication.questId, questId)).for('update');
      const selected = candidates.find((candidate) => candidate.id === target.id);
      if (!selected) return discardCommand('application-not-found');
      if (selected.applicationStatus !== applicationStatus.applied || selected.workerId === hirerId) return discardCommand('not-selectable');
      roster.push(selected.workerId);
      if (assignmentRows.some((assignment) => assignment.workerId === selected.workerId)) return discardCommand('already-assigned');
      await tx.update(questApplication).set({ applicationStatus: applicationStatus.selected }).where(eq(questApplication.id, selected.id));
      await tx.update(questApplication).set({ applicationStatus: applicationStatus.rejected }).where(and(eq(questApplication.questId, questId), eq(questApplication.applicationStatus, applicationStatus.applied), sql`${questApplication.id} <> ${selected.id}`));
    } else {
      const teams = await tx.select(teamFields).from(questTeam).where(eq(questTeam.questId, questId)).for('update');
      const selected = teams.find((team) => team.id === target.id);
      if (!selected) return discardCommand('team-not-found');
      if (selected.teamStatus !== teamStatus.submitted) return discardCommand('not-selectable');
      const members = await tx.select({ userId: questTeamMember.userId, joinedAt: questTeamMember.joinedAt }).from(questTeamMember).where(eq(questTeamMember.teamId, selected.id)).orderBy(asc(questTeamMember.joinedAt), asc(questTeamMember.userId)).for('update');
      if (members.length !== current.headcount) return discardCommand('headcount-mismatch');
      roster.push(...members.map((member) => member.userId));
      if (new Set(roster).size !== roster.length || roster.includes(hirerId) || roster.some((workerId) => assignmentRows.some((assignment) => assignment.workerId === workerId))) return discardCommand('already-assigned');
      await tx.update(questTeam).set({ teamStatus: teamStatus.selected }).where(eq(questTeam.id, selected.id));
      await tx.update(questTeam).set({ teamStatus: teamStatus.rejected }).where(and(eq(questTeam.questId, questId), eq(questTeam.teamStatus, teamStatus.submitted), sql`${questTeam.id} <> ${selected.id}`));
    }

    const assignments = await tx.insert(questAssignment).values(roster.map((workerId) => ({ questId, workerId, assignmentStatus: assignmentStatus.active, createdAt: now }))).returning(selectionAssignmentFields);
    await tx.update(quest).set({ questStatus: questStatus.assigned, version: sql`${quest.version} + 1`, updatedAt: now }).where(and(eq(quest.id, questId), eq(quest.questStatus, questStatus.open)));
    try {
      await writer.applyQuestTransition(tx, selectionTransition(commandId, questId, hirerId, now, assignments));
    } catch (cause) {
      throw new WorkChatTransitionError(cause);
    }
    await tx.update(questCandidateSelectionCommand).set({ resultAssignmentIds: assignments.map((assignment) => assignment.id), resultQuestStatus: questStatus.assigned, processingStatus: 'COMPLETED', completedAt: now }).where(eq(questCandidateSelectionCommand.commandId, commandId));
    return { assignments, questStatus: questStatus.assigned };
  });
};
