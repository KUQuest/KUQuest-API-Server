import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
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
  updateTeam,
} from '@/modules/quest/quest-candidate.service';

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
    { id: invitedUserId, email: `${invitedUserId}@ku.th`, firstName: 'Invited', lastName: 'Member' },
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
  await db.delete(quest).where(eq(quest.id, questId));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, [hirerId, leaderId, memberId, invitedUserId]));
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
    expect((await listTeamInvitations(leaderId, questId, teamId))?.map(({ id }) => id)).toEqual([invitationId]);
  });
});
