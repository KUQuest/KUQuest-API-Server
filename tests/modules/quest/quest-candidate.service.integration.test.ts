import { db, sql } from '@/database/client';
import { auditRecord } from '@/database/schema/audit.schema';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questApplication,
  questAssignment,
  questTeam,
  questTeamInvitation,
  questTeamMember,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  getTeam,
  listTeamInvitations,
  listTeamMembers,
  listTeams,
  selectCandidate,
  submitTeam,
  updateTeam,
} from '@/modules/quest/v1';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const hirerId = randomUUID();
const leaderId = randomUUID();
const memberId = randomUUID();
const invitedUserId = randomUUID();
const tagId = randomUUID();
const questId = randomUUID();
const teamId = randomUUID();
const invitationId = randomUUID();
const testQuestIds: string[] = [];

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error('These tests need PostgreSQL. Start the local database first.', { cause });
  }

  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Candidate', lastName: 'Hirer' },
    { id: leaderId, email: `${leaderId}@ku.th`, firstName: 'Team', lastName: 'Leader' },
    { id: memberId, email: `${memberId}@ku.th`, firstName: 'Team', lastName: 'Member' },
    {
      id: invitedUserId,
      email: `${invitedUserId}@ku.th`,
      firstName: 'Invited',
      lastName: 'Member',
    },
  ]);
  await db.insert(tag).values({ id: tagId, name: `Candidate Team test ${tagId}` });
  await db.insert(quest).values({
    id: questId,
    hirerId,
    title: 'Candidate Team authorization test',
    condition: 'Complete the work',
    mode: 'CANDIDATE',
    participation: 'GROUP',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 500,
    tagId,
    headcount: 2,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
  });
  await db.insert(questTeam).values({
    id: teamId,
    questId,
    leaderId,
    name: 'Authorization Team',
    teamStatus: 'TEAM_FORMING',
  });
  await db.insert(questTeamMember).values([
    { teamId, userId: leaderId, joinedAt: new Date('2030-01-01T10:00:00.000Z') },
    { teamId, userId: memberId, joinedAt: new Date('2030-01-01T10:01:00.000Z') },
  ]);
  await db.insert(questTeamInvitation).values({
    id: invitationId,
    teamId,
    invitedUserId,
    invitedByUserId: leaderId,
    createdAt: new Date('2030-01-01T10:00:00.000Z'),
    expiresAt: new Date('2030-01-02T10:00:00.000Z'),
  });
});

afterAll(async () => {
  await db
    .delete(auditRecord)
    .where(inArray(auditRecord.actorUserId, [hirerId, leaderId, memberId, invitedUserId]));
  await db.delete(quest).where(inArray(quest.id, [questId, ...testQuestIds]));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db
    .delete(authUser)
    .where(inArray(authUser.id, [hirerId, leaderId, memberId, invitedUserId]));
});

describe('Candidate Team authorization persistence', () => {
  it('executes Team member authorization for Team reads and mutations', async () => {
    const team = await getTeam(memberId, questId, teamId);
    expect(team?.id).toBe(teamId);
    expect(team?.members.map(({ userId }) => userId)).toEqual([leaderId, memberId]);

    const teams = await listTeams(memberId, questId);
    if ('outcome' in teams) throw new Error(`Unexpected Team collection outcome: ${teams.outcome}`);
    expect(teams).toHaveLength(1);
    expect(teams[0]?.id).toBe(teamId);

    const members = await listTeamMembers(memberId, questId, teamId);
    expect(members?.map(({ userId }) => userId)).toEqual([leaderId, memberId]);

    expect(await updateTeam(memberId, questId, teamId, { name: 'Not allowed' })).toEqual({
      outcome: 'not-authorized',
    });
    expect(await listTeamInvitations(memberId, questId, teamId)).toBeUndefined();
    expect((await listTeamInvitations(leaderId, questId, teamId))?.map(({ id }) => id)).toEqual([
      invitationId,
    ]);
  });

  it('does not submit a Candidate Team that has a Member with an active Red Flag', async () => {
    const now = new Date('2031-01-01T00:00:00.000Z');
    await db
      .update(authUser)
      .set({ redFlagExpiresAt: new Date(now.getTime() + 60_000) })
      .where(eq(authUser.id, memberId));

    try {
      expect(await submitTeam(leaderId, questId, teamId, now)).toEqual({ outcome: 'red-flagged' });
      const [team] = await db
        .select({ teamStatus: questTeam.teamStatus })
        .from(questTeam)
        .where(eq(questTeam.id, teamId));
      expect(team?.teamStatus).toBe('TEAM_FORMING');
    } finally {
      await db.update(authUser).set({ redFlagExpiresAt: null }).where(eq(authUser.id, memberId));
    }
  });

  it('keeps a Candidate application selectable when an overlapping Worker Assignment blocks selection', async () => {
    const activeQuestId = randomUUID();
    const selectionQuestId = randomUUID();
    const applicationId = randomUUID();
    testQuestIds.push(activeQuestId, selectionQuestId);
    await db.insert(quest).values([
      {
        id: activeQuestId,
        hirerId,
        title: 'Existing Worker Quest',
        condition: 'Complete the work',
        mode: 'CANDIDATE',
        participation: 'SOLO',
        questStatus: 'QUEST_ASSIGNED',
        rewardSatang: 500,
        tagId,
        headcount: 1,
        startTime: new Date('2030-01-01T10:00:00.000Z'),
        dueAt: new Date('2030-01-01T12:00:00.000Z'),
      },
      {
        id: selectionQuestId,
        hirerId,
        title: 'Overlapping Candidate Quest',
        condition: 'Complete the work',
        mode: 'CANDIDATE',
        participation: 'SOLO',
        questStatus: 'QUEST_OPEN',
        rewardSatang: 500,
        tagId,
        headcount: 1,
        startTime: new Date('2030-01-01T11:00:00.000Z'),
        dueAt: new Date('2030-01-01T13:00:00.000Z'),
      },
    ]);
    await db.insert(questAssignment).values({
      questId: activeQuestId,
      workerId: leaderId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
    });
    await db.insert(questApplication).values({
      id: applicationId,
      questId: selectionQuestId,
      workerId: leaderId,
      applicationStatus: 'APPLICATION_APPLIED',
    });

    expect(
      await selectCandidate(
        hirerId,
        selectionQuestId,
        { type: 'APPLICATION', id: applicationId },
        { commandId: `candidate-overlap-${applicationId}` }
      )
    ).toEqual({ outcome: 'worker-schedule-conflict' });
    expect(
      await db
        .select({ state: questApplication.applicationStatus })
        .from(questApplication)
        .where(eq(questApplication.id, applicationId))
    ).toEqual([{ state: 'APPLICATION_APPLIED' }]);
  });

  it('keeps a submitted Candidate Team selectable when a Team Member has an overlapping Worker Assignment', async () => {
    const activeQuestId = randomUUID();
    const selectionQuestId = randomUUID();
    const selectionTeamId = randomUUID();
    testQuestIds.push(activeQuestId, selectionQuestId);
    await db.insert(quest).values([
      {
        id: activeQuestId,
        hirerId,
        title: 'Existing Worker Team Quest',
        condition: 'Complete the work',
        mode: 'CANDIDATE',
        participation: 'GROUP',
        questStatus: 'QUEST_ASSIGNED',
        rewardSatang: 500,
        tagId,
        headcount: 1,
        startTime: new Date('2030-01-01T10:00:00.000Z'),
        dueAt: new Date('2030-01-01T12:00:00.000Z'),
      },
      {
        id: selectionQuestId,
        hirerId,
        title: 'Overlapping Candidate Team Quest',
        condition: 'Complete the work',
        mode: 'CANDIDATE',
        participation: 'GROUP',
        questStatus: 'QUEST_OPEN',
        rewardSatang: 500,
        tagId,
        headcount: 2,
        startTime: new Date('2030-01-01T11:00:00.000Z'),
        dueAt: new Date('2030-01-01T13:00:00.000Z'),
      },
    ]);
    await db.insert(questAssignment).values({
      questId: activeQuestId,
      workerId: memberId,
      assignmentStatus: 'ASSIGNMENT_ACTIVE',
    });
    await db.insert(questTeam).values({
      id: selectionTeamId,
      questId: selectionQuestId,
      leaderId,
      name: 'Overlapping Candidate Team',
      teamStatus: 'TEAM_SUBMITTED',
    });
    await db.insert(questTeamMember).values([
      { teamId: selectionTeamId, userId: leaderId, joinedAt: new Date('2030-01-01T09:00:00.000Z') },
      { teamId: selectionTeamId, userId: memberId, joinedAt: new Date('2030-01-01T09:01:00.000Z') },
    ]);

    expect(
      await selectCandidate(
        hirerId,
        selectionQuestId,
        { type: 'TEAM', id: selectionTeamId },
        { commandId: `candidate-team-overlap-${selectionTeamId}` }
      )
    ).toEqual({ outcome: 'worker-schedule-conflict' });
    expect(
      await db
        .select({ state: questTeam.teamStatus })
        .from(questTeam)
        .where(eq(questTeam.id, selectionTeamId))
    ).toEqual([{ state: 'TEAM_SUBMITTED' }]);
  });
});
