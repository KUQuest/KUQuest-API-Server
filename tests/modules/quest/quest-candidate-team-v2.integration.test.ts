import { app } from '@/app';
import { db, sql as postgresSql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  quest,
  questCandidateApplicationV2,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import {
  chatConversation,
  chatMembership,
  chatMessage,
  chatTransitionCommand,
} from '@/database/schema/work-chat.schema';
import { auth } from '@/modules/auth';
import {
  configureQuestWorkChatMembershipWriter,
  type QuestTransaction,
} from '@/modules/quest';
import type { QuestWorkChatMembershipTransition } from '@/modules/quest/quest-work-chat.contract';
import { createWorkChatMembershipWriter } from '@/modules/work-chat';

import { randomUUID } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `candidate-team-v2-hirer-${randomUUID()}@ku.th`,
  firstName: 'Candidate Team',
  lastName: 'Hirer',
};
const candidate = {
  id: randomUUID(),
  email: `candidate-team-v2-worker-${randomUUID()}@ku.th`,
  firstName: 'Candidate',
  lastName: 'Worker',
};
const secondCandidate = {
  id: randomUUID(),
  email: `candidate-team-v2-worker-two-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Candidate',
};
const thirdCandidate = {
  id: randomUUID(),
  email: `candidate-team-v2-worker-three-${randomUUID()}@ku.th`,
  firstName: 'Third',
  lastName: 'Candidate',
};
const fourthCandidate = {
  id: randomUUID(),
  email: `candidate-team-v2-worker-four-${randomUUID()}@ku.th`,
  firstName: 'Fourth',
  lastName: 'Candidate',
};
const unrelated = {
  id: randomUUID(),
  email: `candidate-team-v2-unrelated-${randomUUID()}@ku.th`,
  firstName: 'Unrelated',
  lastName: 'Member',
};
const memberIds = [
  hirer.id,
  candidate.id,
  secondCandidate.id,
  thirdCandidate.id,
  fourthCandidate.id,
  unrelated.id,
];
const tagId = randomUUID();
const questIds: string[] = [];
const fileIds: string[] = [];
let postgresAvailable = false;
let transitions: QuestWorkChatMembershipTransition[] = [];
let writerFailure: Error | undefined;

type OpenApiOperation = {
  operationId?: string;
  security?: unknown;
  parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
};

const successfulWriter = {
  applyQuestTransition: async (
    _transaction: QuestTransaction,
    transition: QuestWorkChatMembershipTransition,
  ) => {
    transitions.push(transition);
    if (writerFailure) throw writerFailure;
    return { conversationId: 'test-conversation', outcome: 'APPLIED' as const };
  },
};

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const memberId = headers.get('x-member-id') ?? candidate.id;
  const member = [hirer, candidate, secondCandidate, thirdCandidate, fourthCandidate, unrelated]
    .find(({ id }) => id === memberId) ?? candidate;
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const request = (
  path: string,
  method = 'GET',
  memberId: string = candidate.id,
  headers: HeadersInit = {},
  body?: BodyInit,
) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: { ...headers, 'x-member-id': memberId },
  body,
}));

const createOpenGroupCandidateQuest = async (
  overrides: Partial<typeof quest.$inferInsert> = {},
) => {
  const id = randomUUID();
  questIds.push(id);
  await db.insert(quest).values({
    id,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Candidate Team V2 test Quest',
    condition: 'Complete the team work',
    mode: 'CANDIDATE',
    participation: 'GROUP',
    v2Mode: 'CANDIDATE',
    v2Participation: 'GROUP',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1000,
    questFundingTotalSatang: 3000,
    tagId,
    headcount: 3,
    startTime: new Date('2030-01-01T10:00:00.000Z'),
    ...overrides,
  });
  return id;
};

const createTeam = async (
  questId: string,
  leaderId = candidate.id,
  headcount = 3,
  commandId = `candidate-team-v2-create-${randomUUID()}`,
) => {
  const response = await request(
    `/api/v2/quests/${questId}/teams`,
    'POST',
    leaderId,
    { 'content-type': 'application/json', 'idempotency-key': commandId },
    JSON.stringify({ headcount }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).data as {
    id: string;
    leaderId: string;
    headcount: number;
    joinCode: string;
    joinCodeExpiresAt: string;
  };
};

const joinTeam = async (
  questId: string,
  teamId: string,
  memberId: string,
  joinCode: string,
  commandId = `candidate-team-v2-join-${randomUUID()}`,
) => request(
  `/api/v2/quests/${questId}/teams/${teamId}/join`,
  'POST',
  memberId,
  { 'content-type': 'application/json', 'idempotency-key': commandId },
  JSON.stringify({ joinCode }),
);

const createFile = async (
  uploadedByUserId: string,
  contentType = 'application/pdf',
  sizeBytes = 100,
) => {
  const id = randomUUID();
  fileIds.push(id);
  await db.insert(file).values({
    id,
    bucket: 'candidate-team-v2-test',
    objectKey: `${id}.bin`,
    contentType,
    sizeBytes,
    uploadedByUserId,
  });
  return id;
};

beforeAll(async () => {
  try {
    await postgresSql`select 1`;
    postgresAvailable = true;
  } catch {
    console.warn('Skipping Candidate Team V2 persistence tests: PostgreSQL is unavailable');
    return;
  }
  await db.insert(authUser).values([hirer, candidate, secondCandidate, thirdCandidate, fourthCandidate, unrelated]);
  await db.insert(tag).values({ id: tagId, name: 'Candidate Team V2 test tag' });
});

beforeEach(() => {
  transitions = [];
  writerFailure = undefined;
  configureQuestWorkChatMembershipWriter(successfulWriter);
});

afterEach(async () => {
  configureQuestWorkChatMembershipWriter(undefined);
  mock.restore();
  if (!postgresAvailable) return;

  if (questIds.length > 0) {
    const conversations = await db
      .select({ id: chatConversation.id })
      .from(chatConversation)
      .where(inArray(chatConversation.questId, questIds));
    const conversationIds = conversations.map(({ id }) => id);
    if (conversationIds.length > 0) {
      await db.delete(chatMessage).where(inArray(chatMessage.conversationId, conversationIds));
      await db.delete(chatMembership).where(inArray(chatMembership.conversationId, conversationIds));
      await db.delete(chatTransitionCommand).where(inArray(chatTransitionCommand.questId, questIds));
      await db.delete(chatConversation).where(inArray(chatConversation.id, conversationIds));
    }
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
  if (fileIds.length > 0) {
    await db.delete(file).where(inArray(file.id, fileIds));
    fileIds.splice(0, fileIds.length);
  }
  await db.delete(walletIdempotencyKey).where(inArray(walletIdempotencyKey.principalUserId, memberIds));
});

afterAll(async () => {
  if (!postgresAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, memberIds));
});

describe('Quest Candidate Team API v2', () => {
  it('publishes the V2 Candidate Team contract and keeps Join Code plaintext out of reads', async () => {
    const response = await request('/openapi/json');
    const document = await response.json() as {
      paths: Record<string, Record<string, OpenApiOperation>>;
    };
    const collection = document.paths['/api/v2/quests/{questId}/teams'];
    const detail = document.paths['/api/v2/quests/{questId}/teams/{teamId}'];
    const join = document.paths['/api/v2/quests/{questId}/teams/{teamId}/join']?.post;
    const leave = document.paths['/api/v2/quests/{questId}/teams/{teamId}/leave']?.post;
    const remove = document.paths['/api/v2/quests/{questId}/teams/{teamId}/members/{memberId}']?.delete;
    const regenerate = document.paths['/api/v2/quests/{questId}/teams/{teamId}/join-code']?.post;
    const submit = document.paths['/api/v2/quests/{questId}/teams/{teamId}/submit']?.post;
    const select = document.paths['/api/v2/quests/{questId}/teams/{teamId}/select']?.post;

    expect(collection?.post?.operationId).toBe('createQuestCandidateTeamV2');
    expect(collection?.get?.operationId).toBe('listQuestCandidateTeamsV2');
    expect(detail?.get?.operationId).toBe('getQuestCandidateTeamV2');
    expect(join?.operationId).toBe('joinQuestCandidateTeamV2');
    expect(leave?.operationId).toBe('leaveQuestCandidateTeamV2');
    expect(remove?.operationId).toBe('removeQuestCandidateTeamMemberV2');
    expect(regenerate?.operationId).toBe('regenerateQuestCandidateTeamJoinCodeV2');
    expect(submit?.operationId).toBe('submitQuestCandidateTeamV2');
    expect(select?.operationId).toBe('selectQuestCandidateTeamV2');

    for (const operation of [collection?.post, join, leave, remove, regenerate, submit, select]) {
      expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
      expect(operation?.parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: 'idempotency-key',
          in: 'header',
          required: true,
        }),
      ]));
    }
    expect(Object.keys(document.paths).some((path) =>
      path.startsWith('/api/v2/quests/') && path.includes('/invitations'),
    )).toBe(false);
  });

  it('lets the owning Hirer inspect all Candidate Teams and limits other Members to permitted Teams', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId, candidate.id, 2, 'candidate-team-v2-read-create');

    const hirerList = await request(`/api/v2/quests/${questId}/teams`, 'GET', hirer.id);
    expect(hirerList.status).toBe(200);
    expect((await hirerList.json()).data.items).toEqual([
      expect.objectContaining({ id: team.id, joinCode: null }),
    ]);

    const memberList = await request(`/api/v2/quests/${questId}/teams`, 'GET', candidate.id);
    expect(memberList.status).toBe(200);
    expect((await memberList.json()).data.items).toEqual([
      expect.objectContaining({ id: team.id, joinCode: null }),
    ]);

    const detail = await request(`/api/v2/quests/${questId}/teams/${team.id}`, 'GET', hirer.id);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data).toMatchObject({ id: team.id, joinCode: null });

    const unrelatedRead = await request(`/api/v2/quests/${questId}/teams`, 'GET', unrelated.id);
    expect(unrelatedRead.status).toBe(404);
    expect((await unrelatedRead.json()).error.code).toBe('QUEST_NOT_FOUND');
  });

  it('creates one forming Candidate Team with a 24-hour Join Code and replays creation', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();

    const missingKey = await request(
      `/api/v2/quests/${questId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json' },
      JSON.stringify({ headcount: 3 }),
    );
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const first = await request(
      `/api/v2/quests/${questId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-create-1' },
      JSON.stringify({ headcount: 3 }),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { data: Record<string, unknown> };
    const team = firstBody.data as {
      id: string;
      leaderId: string;
      headcount: number;
      state: string;
      joinCode: string;
      joinCodeExpiresAt: string;
      members: Array<{ memberId: string }>;
    };
    expect(team).toMatchObject({
      leaderId: candidate.id,
      headcount: 3,
      state: 'TEAM_FORMING',
      members: [{ memberId: candidate.id }],
    });
    expect(team.joinCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(new Date(team.joinCodeExpiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(new Date(team.joinCodeExpiresAt).getTime() - Date.now()).toBeLessThan(25 * 60 * 60 * 1000);

    const replay = await request(
      `/api/v2/quests/${questId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-create-1' },
      JSON.stringify({ headcount: 3 }),
    );
    expect(replay.status).toBe(201);
    expect((await replay.json()).data).toEqual(firstBody.data);

    const read = await request(`/api/v2/quests/${questId}/teams/${team.id}`, 'GET', candidate.id);
    expect(read.status).toBe(200);
    const readTeam = (await read.json()).data as Record<string, unknown>;
    expect(readTeam.joinCode).toBeNull();
    expect(readTeam.joinCodeExpiresAt).toBe(team.joinCodeExpiresAt);

    const secondTeam = await request(
      `/api/v2/quests/${questId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-create-2' },
      JSON.stringify({ headcount: 2 }),
    );
    expect(secondTeam.status).toBe(409);
    expect((await secondTeam.json()).error.code).toBe('TEAM_MEMBERSHIP_ALREADY_EXISTS');
  });

  it('enforces current Join Code, expiry, regeneration, membership uniqueness, and team capacity', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId);

    const firstJoin = await joinTeam(questId, team.id, secondCandidate.id, team.joinCode, 'candidate-team-v2-join-1');
    expect(firstJoin.status).toBe(200);

    const duplicate = await joinTeam(questId, team.id, secondCandidate.id, team.joinCode, 'candidate-team-v2-join-2');
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.code).toBe('TEAM_MEMBERSHIP_ALREADY_EXISTS');

    const regenerated = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/join-code`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-team-v2-regenerate-1' },
    );
    expect(regenerated.status).toBe(200);
    const regeneratedBody = (await regenerated.json()).data as { joinCode: string; joinCodeExpiresAt: string };
    expect(regeneratedBody.joinCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(regeneratedBody.joinCode).not.toBe(team.joinCode);

    const oldCode = await joinTeam(questId, team.id, unrelated.id, team.joinCode, 'candidate-team-v2-old-code');
    expect(oldCode.status).toBe(409);
    expect((await oldCode.json()).error.code).toBe('JOIN_CODE_INVALID');

    const currentCode = await joinTeam(questId, team.id, thirdCandidate.id, regeneratedBody.joinCode, 'candidate-team-v2-join-3');
    expect(currentCode.status).toBe(200);

    const full = await joinTeam(questId, team.id, fourthCandidate.id, regeneratedBody.joinCode, 'candidate-team-v2-join-full');
    expect(full.status).toBe(409);
    expect((await full.json()).error.code).toBe('TEAM_FULL');

    const expiredTeam = await createTeam(questId, fourthCandidate.id, 2, 'candidate-team-v2-create-expired');
    await db.update(questCandidateTeamV2)
      .set({ joinCodeExpiresAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(questCandidateTeamV2.id, expiredTeam.id));
    const expired = await joinTeam(questId, expiredTeam.id, unrelated.id, expiredTeam.joinCode, 'candidate-team-v2-expired');
    expect(expired.status).toBe(409);
    expect((await expired.json()).error.code).toBe('JOIN_CODE_EXPIRED');

    const changed = await joinTeam(questId, team.id, thirdCandidate.id, team.joinCode, 'candidate-team-v2-join-3');
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('allows forming Members to leave, transfers leadership, removes Members, and disbands an empty Team', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId);
    await joinTeam(questId, team.id, secondCandidate.id, team.joinCode, 'candidate-team-v2-leave-join-one');
    await joinTeam(questId, team.id, thirdCandidate.id, team.joinCode, 'candidate-team-v2-leave-join-two');

    const leaderLeave = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/leave`,
      'POST',
      candidate.id,
      { 'idempotency-key': 'candidate-team-v2-leave-leader' },
    );
    expect(leaderLeave.status).toBe(200);
    const afterTransfer = (await leaderLeave.json()).data as {
      leaderId: string;
      members: Array<{ memberId: string; joinedAt: string }>;
    };
    expect(afterTransfer.leaderId).toBe(afterTransfer.members[0]?.memberId);
    expect(afterTransfer.members).not.toContainEqual(expect.objectContaining({ memberId: candidate.id }));

    const removed = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/members/${thirdCandidate.id}`,
      'DELETE',
      afterTransfer.leaderId,
      { 'idempotency-key': 'candidate-team-v2-remove-one' },
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).data.members).toEqual([
      expect.objectContaining({ memberId: afterTransfer.leaderId }),
    ]);

    const lastLeave = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/leave`,
      'POST',
      afterTransfer.leaderId,
      { 'idempotency-key': 'candidate-team-v2-leave-last' },
    );
    expect(lastLeave.status).toBe(200);
    expect((await lastLeave.json()).data).toMatchObject({ state: 'TEAM_DISBANDED', members: [], joinCode: null });

    const read = await request(`/api/v2/quests/${questId}/teams/${team.id}`, 'GET', afterTransfer.leaderId);
    expect(read.status).toBe(404);
    expect((await read.json()).error.code).toBe('TEAM_NOT_FOUND');

    const [storedTeam] = await db
      .select({ state: questCandidateTeamV2.state })
      .from(questCandidateTeamV2)
      .where(eq(questCandidateTeamV2.id, team.id));
    expect(storedTeam?.state).toBe('TEAM_DISBANDED');
  });

  it('submits only a full Team with valid files and makes the submission immutable', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId);
    const underfilledFileId = randomUUID();

    const underfilled = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-submit-underfilled' },
      JSON.stringify({ text: 'Team work', fileIds: [underfilledFileId] }),
    );
    expect(underfilled.status).toBe(409);
    expect((await underfilled.json()).error.code).toBe('TEAM_HEADCOUNT_MISMATCH');

    await joinTeam(questId, team.id, secondCandidate.id, team.joinCode, 'candidate-team-v2-submit-join-one');
    await joinTeam(questId, team.id, thirdCandidate.id, team.joinCode, 'candidate-team-v2-submit-join-two');
    const underfilledRetry = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-submit-underfilled' },
      JSON.stringify({ text: 'Team work', fileIds: [underfilledFileId] }),
    );
    expect(underfilledRetry.status).toBe(409);
    expect((await underfilledRetry.json()).error.code).toBe('TEAM_HEADCOUNT_MISMATCH');

    const invalidFileId = await createFile(candidate.id, 'text/plain');
    const invalidFiles = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-submit-invalid-file' },
      JSON.stringify({ text: 'Team work', fileIds: [invalidFileId] }),
    );
    expect(invalidFiles.status).toBe(409);
    expect((await invalidFiles.json()).error.code).toBe('TEAM_SUBMISSION_FILES_INVALID');

    const validFileId = await createFile(candidate.id);
    const submitted = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-submit-valid' },
      JSON.stringify({ text: '  Team work  ', fileIds: [validFileId] }),
    );
    expect(submitted.status).toBe(200);
    const body = (await submitted.json()).data as Record<string, unknown>;
    expect(body).toMatchObject({ state: 'TEAM_SUBMITTED', joinCode: null, joinCodeExpiresAt: null });
    expect(body.submission).toMatchObject({ text: 'Team work', fileIds: [validFileId] });

    const changed = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-submit-valid' },
      JSON.stringify({ text: 'Changed work', fileIds: [validFileId] }),
    );
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const retry = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-submit-valid' },
      JSON.stringify({ text: '  Team work  ', fileIds: [validFileId] }),
    );
    expect(retry.status).toBe(200);
    expect((await retry.json()).data).toEqual(body);

    const joinAfterSubmit = await joinTeam(questId, team.id, fourthCandidate.id, team.joinCode ?? '', 'candidate-team-v2-join-after-submit');
    expect(joinAfterSubmit.status).toBe(409);
    expect((await joinAfterSubmit.json()).error.code).toBe('TEAM_NOT_FORMING');
  });

  it('selects one submitted Team atomically, creates the full Assignment roster, and rejects other Candidates', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const firstTeam = await createTeam(questId, candidate.id, 3, 'candidate-team-v2-select-create-one');
    await joinTeam(questId, firstTeam.id, secondCandidate.id, firstTeam.joinCode, 'candidate-team-v2-select-join-one');
    await joinTeam(questId, firstTeam.id, fourthCandidate.id, firstTeam.joinCode, 'candidate-team-v2-select-join-two');
    const secondTeam = await createTeam(questId, thirdCandidate.id, 2, 'candidate-team-v2-select-create-two');
    await joinTeam(questId, secondTeam.id, unrelated.id, secondTeam.joinCode, 'candidate-team-v2-select-join-three');

    const firstFileId = await createFile(candidate.id);
    const secondFileId = await createFile(thirdCandidate.id);
    const firstSubmit = await request(
      `/api/v2/quests/${questId}/teams/${firstTeam.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-select-submit-one' },
      JSON.stringify({ text: 'First Team', fileIds: [firstFileId] }),
    );
    const secondSubmit = await request(
      `/api/v2/quests/${questId}/teams/${secondTeam.id}/submit`,
      'POST',
      thirdCandidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-select-submit-two' },
      JSON.stringify({ text: 'Second Team', fileIds: [secondFileId] }),
    );
    expect(firstSubmit.status).toBe(200);
    expect(secondSubmit.status).toBe(200);

    await db.insert(questCandidateApplicationV2).values({
      questId,
      memberId: unrelated.id,
      state: 'APPLICATION_APPLIED',
    });

    const selected = await request(
      `/api/v2/quests/${questId}/teams/${firstTeam.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-select-one' },
    );
    expect(selected.status).toBe(200);
    const selectedBody = (await selected.json()).data as {
      questState: string;
      assignments: Array<{ workerId: string; state: string; questState: string }>;
    };
    expect(selectedBody.questState).toBe('QUEST_ASSIGNED');
    expect(selectedBody.assignments).toHaveLength(3);
    expect(selectedBody.assignments.map(({ workerId }) => workerId)).toEqual(
      expect.arrayContaining([candidate.id, secondCandidate.id, fourthCandidate.id]),
    );
    expect(selectedBody.assignments.every(({ state, questState }) =>
      state === 'ASSIGNMENT_ACTIVE' && questState === 'QUEST_ASSIGNED',
    )).toBe(true);

    const replay = await request(
      `/api/v2/quests/${questId}/teams/${firstTeam.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-select-one' },
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).data).toEqual(selectedBody);

    const [currentQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(currentQuest?.state).toBe('QUEST_ASSIGNED');
    const teams = await db
      .select({ id: questCandidateTeamV2.id, state: questCandidateTeamV2.state })
      .from(questCandidateTeamV2)
      .where(eq(questCandidateTeamV2.questId, questId));
    expect(teams).toEqual(expect.arrayContaining([
      { id: firstTeam.id, state: 'TEAM_SELECTED' },
      { id: secondTeam.id, state: 'TEAM_REJECTED' },
    ]));
    const applications = await db
      .select({ state: questCandidateApplicationV2.state })
      .from(questCandidateApplicationV2)
      .where(eq(questCandidateApplicationV2.questId, questId));
    expect(applications).toEqual([{ state: 'APPLICATION_REJECTED' }]);
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(3);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      producer: 'QUEST_CANDIDATE_SELECTION',
      type: 'workersAccepted',
      actorId: hirer.id,
      questId,
    });
    expect(transitions[0]?.type === 'workersAccepted' ? transitions[0].workers : []).toHaveLength(3);

    const losingSelection = await request(
      `/api/v2/quests/${questId}/teams/${secondTeam.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-select-two' },
    );
    expect(losingSelection.status).toBe(409);
    expect((await losingSelection.json()).error.code).toBe('QUEST_NOT_OPEN');
  });

  it('serializes concurrent Team selections so only one complete roster is accepted', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const firstTeam = await createTeam(questId, candidate.id, 2, 'candidate-team-v2-concurrent-create-one');
    await joinTeam(
      questId,
      firstTeam.id,
      secondCandidate.id,
      firstTeam.joinCode,
      'candidate-team-v2-concurrent-join-one',
    );
    const secondTeam = await createTeam(questId, thirdCandidate.id, 2, 'candidate-team-v2-concurrent-create-two');
    await joinTeam(
      questId,
      secondTeam.id,
      fourthCandidate.id,
      secondTeam.joinCode,
      'candidate-team-v2-concurrent-join-two',
    );

    const firstFileId = await createFile(candidate.id);
    const secondFileId = await createFile(thirdCandidate.id);
    const firstSubmit = await request(
      `/api/v2/quests/${questId}/teams/${firstTeam.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-concurrent-submit-one' },
      JSON.stringify({ text: 'First submitted team', fileIds: [firstFileId] }),
    );
    const secondSubmit = await request(
      `/api/v2/quests/${questId}/teams/${secondTeam.id}/submit`,
      'POST',
      thirdCandidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-concurrent-submit-two' },
      JSON.stringify({ text: 'Second submitted team', fileIds: [secondFileId] }),
    );
    expect(firstSubmit.status).toBe(200);
    expect(secondSubmit.status).toBe(200);

    const responses = await Promise.all([
      request(
        `/api/v2/quests/${questId}/teams/${firstTeam.id}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': 'candidate-team-v2-concurrent-select-one' },
      ),
      request(
        `/api/v2/quests/${questId}/teams/${secondTeam.id}/select`,
        'POST',
        hirer.id,
        { 'idempotency-key': 'candidate-team-v2-concurrent-select-two' },
      ),
    ]);
    expect(responses.map((response) => response.status).sort((left, right) => left - right)).toEqual([200, 409]);
    const losingResponse = responses.find((response) => response.status === 409);
    expect(losingResponse).toBeDefined();
    expect((await losingResponse!.json()).error.code).toBe('QUEST_NOT_OPEN');

    const teams = await db
      .select({ id: questCandidateTeamV2.id, state: questCandidateTeamV2.state })
      .from(questCandidateTeamV2)
      .where(eq(questCandidateTeamV2.questId, questId));
    expect(teams.filter(({ state }) => state === 'TEAM_SELECTED')).toHaveLength(1);
    expect(teams.filter(({ state }) => state === 'TEAM_REJECTED')).toHaveLength(1);
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(2);
    expect(transitions).toHaveLength(1);
  });

  it('creates one Work Conversation for the selected Team roster', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId, candidate.id, 2, 'candidate-team-v2-work-chat-create');
    await joinTeam(
      questId,
      team.id,
      secondCandidate.id,
      team.joinCode,
      'candidate-team-v2-work-chat-join',
    );
    const submissionFileId = await createFile(candidate.id);
    const submitted = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-work-chat-submit' },
      JSON.stringify({ text: 'Team work', fileIds: [submissionFileId] }),
    );
    expect(submitted.status).toBe(200);

    configureQuestWorkChatMembershipWriter(createWorkChatMembershipWriter());
    const selected = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-work-chat-select' },
    );
    expect(selected.status).toBe(200);

    const [conversation] = await db
      .select({
        id: chatConversation.id,
        questStatus: chatConversation.questStatus,
        readOnlyAt: chatConversation.readOnlyAt,
      })
      .from(chatConversation)
      .where(eq(chatConversation.questId, questId));
    expect(conversation).toMatchObject({ questStatus: 'QUEST_ASSIGNED', readOnlyAt: null });

    const memberships = await db
      .select({ memberId: chatMembership.memberId, role: chatMembership.role })
      .from(chatMembership)
      .where(eq(chatMembership.conversationId, conversation!.id));
    expect(memberships).toEqual(expect.arrayContaining([
      { memberId: hirer.id, role: 'HIRER' },
      { memberId: candidate.id, role: 'WORKER' },
      { memberId: secondCandidate.id, role: 'WORKER' },
    ]));
    expect(memberships).toHaveLength(3);

    const messages = await db
      .select({ kind: chatMessage.kind, systemType: chatMessage.systemType })
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, conversation!.id));
    expect(messages).toHaveLength(3);
    expect(messages.every(({ kind, systemType }) => kind === 'SYSTEM' && systemType === 'ACCEPTED_PARTICIPANT_JOINED')).toBe(true);

    const commands = await db
      .select({ processingStatus: chatTransitionCommand.processingStatus })
      .from(chatTransitionCommand)
      .where(eq(chatTransitionCommand.questId, questId));
    expect(commands).toEqual([{ processingStatus: 'COMPLETED' }]);
  });

  it('selects only a full Candidate Team with a stored submission', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId, candidate.id, 2, 'candidate-team-v2-selection-evidence-create');
    await joinTeam(
      questId,
      team.id,
      secondCandidate.id,
      team.joinCode,
      'candidate-team-v2-selection-evidence-join',
    );

    await db.update(questCandidateTeamV2)
      .set({
        state: 'TEAM_SUBMITTED',
        joinCodeHash: null,
        joinCodeExpiresAt: null,
        submissionText: null,
        submittedAt: null,
      })
      .where(eq(questCandidateTeamV2.id, team.id));

    const response = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-selection-evidence-select' },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('CANDIDATE_TEAM_NOT_SELECTABLE');

    const [currentQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(currentQuest?.state).toBe('QUEST_OPEN');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(0);
  });

  it('rejects Team selection by the wrong Hirer, for a forming Team, or after the Quest closes', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const formingTeam = await createTeam(questId, candidate.id, 2, 'candidate-team-v2-selection-state-forming');
    await joinTeam(
      questId,
      formingTeam.id,
      secondCandidate.id,
      formingTeam.joinCode,
      'candidate-team-v2-selection-state-forming-join',
    );

    const formingSelection = await request(
      `/api/v2/quests/${questId}/teams/${formingTeam.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-selection-state-forming-select' },
    );
    expect(formingSelection.status).toBe(409);
    expect((await formingSelection.json()).error.code).toBe('CANDIDATE_TEAM_NOT_SELECTABLE');

    const submittedTeam = await createTeam(questId, thirdCandidate.id, 2, 'candidate-team-v2-selection-state-submitted');
    await joinTeam(
      questId,
      submittedTeam.id,
      fourthCandidate.id,
      submittedTeam.joinCode,
      'candidate-team-v2-selection-state-submitted-join',
    );
    const submissionFileId = await createFile(thirdCandidate.id);
    const submitted = await request(
      `/api/v2/quests/${questId}/teams/${submittedTeam.id}/submit`,
      'POST',
      thirdCandidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-selection-state-submit' },
      JSON.stringify({ text: 'Submitted team', fileIds: [submissionFileId] }),
    );
    expect(submitted.status).toBe(200);

    const wrongHirer = await request(
      `/api/v2/quests/${questId}/teams/${submittedTeam.id}/select`,
      'POST',
      unrelated.id,
      { 'idempotency-key': 'candidate-team-v2-selection-state-wrong-hirer' },
    );
    expect(wrongHirer.status).toBe(409);
    expect((await wrongHirer.json()).error.code).toBe('CANDIDATE_SELECTION_NOT_ALLOWED');

    await db.update(quest)
      .set({ questStatus: 'QUEST_ASSIGNED' })
      .where(eq(quest.id, questId));
    const closed = await request(
      `/api/v2/quests/${questId}/teams/${submittedTeam.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-selection-state-closed' },
    );
    expect(closed.status).toBe(409);
    expect((await closed.json()).error.code).toBe('QUEST_NOT_OPEN');
  });

  it('rejects a submitted Candidate Team when its roster no longer matches its headcount', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId, candidate.id, 2, 'candidate-team-v2-selection-mismatch-create');
    await joinTeam(
      questId,
      team.id,
      secondCandidate.id,
      team.joinCode,
      'candidate-team-v2-selection-mismatch-join',
    );
    const submissionFileId = await createFile(candidate.id);
    const submitted = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-selection-mismatch-submit' },
      JSON.stringify({ text: 'Submitted team', fileIds: [submissionFileId] }),
    );
    expect(submitted.status).toBe(200);

    await db.delete(questCandidateTeamV2Member)
      .where(and(
        eq(questCandidateTeamV2Member.teamId, team.id),
        eq(questCandidateTeamV2Member.memberId, secondCandidate.id),
      ));

    const response = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-selection-mismatch-select' },
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('TEAM_HEADCOUNT_MISMATCH');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(0);
  });

  it('rolls back the Team selection when Work Chat membership cannot be updated', async () => {
    if (!postgresAvailable) return;
    const questId = await createOpenGroupCandidateQuest();
    authenticate();
    const team = await createTeam(questId);
    await joinTeam(questId, team.id, secondCandidate.id, team.joinCode, 'candidate-team-v2-failure-join-one');
    await joinTeam(questId, team.id, thirdCandidate.id, team.joinCode, 'candidate-team-v2-failure-join-two');
    const submissionFileId = await createFile(candidate.id);
    await request(
      `/api/v2/quests/${questId}/teams/${team.id}/submit`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-failure-submit' },
      JSON.stringify({ text: 'Team work', fileIds: [submissionFileId] }),
    );
    await db.insert(questCandidateApplicationV2).values({
      questId,
      memberId: unrelated.id,
      state: 'APPLICATION_APPLIED',
    });
    writerFailure = new Error('chat unavailable');

    const response = await request(
      `/api/v2/quests/${questId}/teams/${team.id}/select`,
      'POST',
      hirer.id,
      { 'idempotency-key': 'candidate-team-v2-failure-select' },
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('WORK_CHAT_UNAVAILABLE');

    const [currentQuest] = await db.select({ state: quest.questStatus }).from(quest).where(eq(quest.id, questId));
    expect(currentQuest?.state).toBe('QUEST_OPEN');
    const [storedTeam] = await db.select({ state: questCandidateTeamV2.state }).from(questCandidateTeamV2).where(eq(questCandidateTeamV2.id, team.id));
    expect(storedTeam?.state).toBe('TEAM_SUBMITTED');
    expect(await db.select().from(questAssignment).where(eq(questAssignment.questId, questId))).toHaveLength(0);
    const [storedApplication] = await db
      .select({ state: questCandidateApplicationV2.state })
      .from(questCandidateApplicationV2)
      .where(and(eq(questCandidateApplicationV2.questId, questId), eq(questCandidateApplicationV2.memberId, unrelated.id)));
    expect(storedApplication?.state).toBe('APPLICATION_APPLIED');
    expect(transitions).toHaveLength(1);
  });

  it('rejects the Hirer, wrong V2 mode or shape, closed Quests, and V1 Quests', async () => {
    if (!postgresAvailable) return;
    authenticate();

    const hirerQuestId = await createOpenGroupCandidateQuest();
    const hirerResponse = await request(
      `/api/v2/quests/${hirerQuestId}/teams`,
      'POST',
      hirer.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-invalid-hirer' },
      JSON.stringify({ headcount: 2 }),
    );
    expect(hirerResponse.status).toBe(409);
    expect((await hirerResponse.json()).error.code).toBe('HIRER_CANNOT_JOIN_TEAM');

    const wrongModeQuestId = await createOpenGroupCandidateQuest({ v2Mode: 'FIRST_COME_FIRST_SERVED' });
    const wrongMode = await request(
      `/api/v2/quests/${wrongModeQuestId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-invalid-mode' },
      JSON.stringify({ headcount: 2 }),
    );
    expect(wrongMode.status).toBe(409);
    expect((await wrongMode.json()).error.code).toBe('QUEST_MODE_NOT_ALLOWED');

    const wrongShapeQuestId = await createOpenGroupCandidateQuest({
      participation: 'SOLO',
      v2Participation: 'SINGLE',
      headcount: 1,
      questFundingTotalSatang: 1000,
    });
    const wrongShape = await request(
      `/api/v2/quests/${wrongShapeQuestId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-invalid-shape' },
      JSON.stringify({ headcount: 2 }),
    );
    expect(wrongShape.status).toBe(409);
    expect((await wrongShape.json()).error.code).toBe('QUEST_PARTICIPATION_NOT_ALLOWED');

    const closedQuestId = await createOpenGroupCandidateQuest({ questStatus: 'QUEST_ASSIGNED' });
    const closed = await request(
      `/api/v2/quests/${closedQuestId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-invalid-state' },
      JSON.stringify({ headcount: 2 }),
    );
    expect(closed.status).toBe(409);
    expect((await closed.json()).error.code).toBe('QUEST_NOT_OPEN');

    const v1QuestId = randomUUID();
    questIds.push(v1QuestId);
    await db.insert(quest).values({
      id: v1QuestId,
      hirerId: hirer.id,
      title: 'Candidate Team V1 boundary test Quest',
      condition: 'Complete the work',
      mode: 'CANDIDATE',
      participation: 'GROUP',
      questStatus: 'QUEST_OPEN',
      rewardSatang: 1000,
      tagId,
      headcount: 2,
      startTime: new Date('2030-01-01T10:00:00.000Z'),
    });
    const v2Response = await request(
      `/api/v2/quests/${v1QuestId}/teams`,
      'POST',
      candidate.id,
      { 'content-type': 'application/json', 'idempotency-key': 'candidate-team-v2-v1-boundary' },
      JSON.stringify({ headcount: 2 }),
    );
    expect(v2Response.status).toBe(404);
    expect((await v2Response.json()).error.code).toBe('QUEST_NOT_FOUND');

    expect(await db.select().from(questCandidateTeamV2Member).where(eq(questCandidateTeamV2Member.memberId, candidate.id))).toHaveLength(0);
  });
});
