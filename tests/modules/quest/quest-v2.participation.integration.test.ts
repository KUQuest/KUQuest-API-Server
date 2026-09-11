import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questApiVersion, questAssignment } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createQuestV2, type QuestV2CreateInput } from '@/modules/quest';
import {
  assignmentStatus,
  questStatus,
  type AssignmentStatus,
  type QuestStatus,
} from '@/modules/quest/quest.contract';

import { Elysia } from 'elysia';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

const workerEmail = `quest-v2-participation-worker-${crypto.randomUUID()}@ku.th`;
const outsiderEmail = `quest-v2-participation-outsider-${crypto.randomUUID()}@ku.th`;
const testPassword = 'TestStudent1!';

const workerAuthApp = new Elysia({ name: 'quest-v2-participation-worker-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: workerEmail,
    password: testPassword,
    firstName: 'Participation',
    lastName: 'Worker',
  }),
);
const outsiderAuthApp = new Elysia({ name: 'quest-v2-participation-outsider-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: outsiderEmail,
    password: testPassword,
    firstName: 'Participation',
    lastName: 'Outsider',
  }),
);

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const signIn = async (auth: Elysia, email: string) => {
  const response = await auth.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: testPassword }),
    }),
  );
  if (response.status !== 200) throw new Error(`Test authentication failed: ${response.status}`);
  const body = (await response.json()) as { user: { id: string } };
  return { id: body.user.id, cookie: getCookieHeader(response) };
};

let workerId = '';
let workerCookie = '';
let outsiderCookie = '';
const ownerId = crypto.randomUUID();
const adminId = crypto.randomUUID();
const tagId = crypto.randomUUID();
const questIds: string[] = [];
const fixturePrefix = `Participation ${crypto.randomUUID()}`;

const baseInput: QuestV2CreateInput = {
  title: fixturePrefix,
  description: 'A participation description',
  condition: { items: ['First condition', 'Second condition'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
  dueAt: '2030-08-26T12:00:00.000+07:00',
  tagId,
  proofRequired: true,
  locations: [{ label: 'First location' }, { label: 'Second location' }],
};

const createPublishedQuest = async (overrides: Partial<QuestV2CreateInput> = {}) => {
  const result = await createQuestV2(
    ownerId,
    { ...baseInput, ...overrides },
    `participation-create-${crypto.randomUUID()}`,
  );
  if (!('quest' in result)) throw new Error(`Create failed: ${result.outcome}`);
  questIds.push(result.quest.id);
  await db
    .update(quest)
    .set({ questStatus: questStatus.open, rewardSatang: 1234 })
    .where(eq(quest.id, result.quest.id));
  return result.quest.id;
};

const assign = async (questId: string, status: AssignmentStatus = assignmentStatus.active) => {
  await db.insert(questAssignment).values({ questId, workerId, assignmentStatus: status });
};

const setQuestState = async (questId: string, status: QuestStatus) => {
  await db.update(quest).set({
    questStatus: status,
    // The quest_cancelled_at_check and quest_failed_at_check constraints pair each
    // terminal state with its timestamp.
    ...(status === questStatus.cancelled ? { cancelledAt: new Date() } : {}),
    ...(status === questStatus.failed ? { failedAt: new Date() } : {}),
  }).where(eq(quest.id, questId));
};

const getParticipation = (questId: string, cookie = workerCookie) =>
  app.handle(new Request(`http://localhost/api/v2/quests/${questId}/participation`, {
    headers: cookie ? { cookie } : {},
  }));

beforeAll(async () => {
  await sql`select 1`;
  const worker = await signIn(workerAuthApp, workerEmail);
  workerId = worker.id;
  workerCookie = worker.cookie;
  outsiderCookie = (await signIn(outsiderAuthApp, outsiderEmail)).cookie;

  await db.insert(authUser).values({
    id: ownerId,
    email: `${ownerId}@ku.th`,
    firstName: 'Quest',
    lastName: 'Owner',
  });
  await db.insert(authAdmin).values({
    id: adminId,
    email: `${adminId}@admin.kuquest`,
    firstName: 'Participation',
    lastName: 'Admin',
  });
  await db.insert(tag).values({ id: tagId, name: `Participation Tag ${crypto.randomUUID()}` });
});

beforeEach(async () => {
  if (questIds.length > 0) {
    await db.delete(quest).where(inArray(quest.id, questIds));
    questIds.splice(0, questIds.length);
  }
});

afterAll(async () => {
  if (questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
  await db.delete(walletIdempotencyKey).where(
    inArray(walletIdempotencyKey.principalUserId, [workerId, ownerId]),
  );
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  await db.delete(authUser).where(eq(authUser.id, ownerId));
});

type ParticipationBody = {
  data: {
    id: string;
    state: string;
    assignment: { status: string; startedAt: string | null };
    capabilities: { canViewOnly: boolean };
  };
};

describe('Quest v2 Participation Detail', () => {
  it('returns the Quest to an Active Worker in every non-terminal State', async () => {
    const assignedQuest = await createPublishedQuest();
    await assign(assignedQuest);
    await setQuestState(assignedQuest, questStatus.assigned);

    const inProgressQuest = await createPublishedQuest();
    await assign(inProgressQuest);
    await setQuestState(inProgressQuest, questStatus.inProgress);

    const assigned = await getParticipation(assignedQuest);
    expect(assigned.status).toBe(200);
    const assignedBody = (await assigned.json()) as ParticipationBody;
    expect(assignedBody.data).toMatchObject({
      id: assignedQuest,
      state: 'QUEST_ASSIGNED',
      assignment: { status: 'ASSIGNMENT_ACTIVE', startedAt: null },
      capabilities: { canViewOnly: false },
    });

    const inProgress = await getParticipation(inProgressQuest);
    expect(inProgress.status).toBe(200);
    expect(((await inProgress.json()) as ParticipationBody).data).toMatchObject({
      state: 'QUEST_IN_PROGRESS',
      capabilities: { canViewOnly: false },
    });
  });

  // Hiding isolates a Quest from discovery only. The Admin Quest Hide Contract keeps
  // Current Accepted Participants unaffected, so the overlay never closes this door.
  it('returns the Quest to a participant while an Admin hides it, without the overlay', async () => {
    const hiddenQuest = await createPublishedQuest();
    await assign(hiddenQuest);
    await db.update(quest).set({
      questStatus: questStatus.assigned,
      hiddenAt: new Date(),
      hiddenByAdminId: adminId,
    }).where(eq(quest.id, hiddenQuest));

    const response = await getParticipation(hiddenQuest);
    expect(response.status).toBe(200);
    const body = (await response.json()) as ParticipationBody & { data: Record<string, unknown> };
    expect(body.data.id).toBe(hiddenQuest);
    expect(body.data).not.toHaveProperty('hiddenAt');
  });

  // AC: a settled Quest stays readable, and the response carries no write capability.
  it.each([
    [questStatus.completed, assignmentStatus.completed],
    [questStatus.failed, assignmentStatus.incomplete],
    [questStatus.cancelled, assignmentStatus.cancelled],
  ])('keeps a terminal Quest readable and read-only (%s)', async (state, assignment) => {
    const terminalQuest = await createPublishedQuest();
    await assign(terminalQuest, assignment);
    await setQuestState(terminalQuest, state);

    const response = await getParticipation(terminalQuest);
    expect(response.status).toBe(200);
    expect(((await response.json()) as ParticipationBody).data).toMatchObject({
      id: terminalQuest,
      state,
      assignment: { status: assignment },
      capabilities: { canViewOnly: true },
    });
  });

  it('reports the Start Work time once the Worker has started', async () => {
    const startedQuest = await createPublishedQuest();
    await assign(startedQuest);
    await setQuestState(startedQuest, questStatus.inProgress);
    await db.update(questAssignment)
      .set({ startedAt: new Date('2030-08-26T03:30:00.000Z') })
      .where(and(
        eq(questAssignment.questId, startedQuest),
        eq(questAssignment.workerId, workerId),
      ));

    const body = (await (await getParticipation(startedQuest)).json()) as ParticipationBody;
    expect(body.data.assignment.startedAt).toBe('2030-08-26T03:30:00.000Z');
  });

  it('refuses every caller without an Assignment on the Quest', async () => {
    const openQuest = await createPublishedQuest();
    const assignedQuest = await createPublishedQuest();
    await assign(assignedQuest);
    await setQuestState(assignedQuest, questStatus.assigned);

    const v1Quest = await createPublishedQuest();
    await assign(v1Quest);
    await db.update(quest).set({ apiVersion: questApiVersion.v1 }).where(eq(quest.id, v1Quest));

    const outsider = await getParticipation(assignedQuest, outsiderCookie);
    const noAssignment = await getParticipation(openQuest);
    const anonymous = await getParticipation(assignedQuest, '');
    const legacy = await getParticipation(v1Quest);
    const missing = await getParticipation('018f47a7-1c7d-7c98-9a11-690d7e83430c');

    expect(outsider.status).toBe(404);
    expect(noAssignment.status).toBe(404);
    expect(anonymous.status).toBe(401);
    expect(legacy.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  // The Hirer reads their own Quest through the owner projection, which carries the
  // Quest Funding Total. Answering here too would publish two shapes for one Quest,
  // so the Hirer is refused even while holding an Assignment row.
  it('refuses the Hirer of the Quest', async () => {
    const result = await createQuestV2(
      workerId,
      baseInput,
      `participation-owner-${crypto.randomUUID()}`,
    );
    if (!('quest' in result)) throw new Error(`Create failed: ${result.outcome}`);
    questIds.push(result.quest.id);
    await db.update(quest).set({
      questStatus: questStatus.assigned,
      rewardSatang: 1234,
    }).where(eq(quest.id, result.quest.id));
    await assign(result.quest.id);

    expect((await getParticipation(result.quest.id)).status).toBe(404);
  });

  // AC: a different Hirer cannot access a Draft. A Draft has no Assignment, so
  // no Member other than its Hirer can read it through this path.
  it('refuses a Draft to a Member who is not its Hirer', async () => {
    const result = await createQuestV2(
      ownerId,
      baseInput,
      `participation-draft-${crypto.randomUUID()}`,
    );
    if (!('quest' in result)) throw new Error(`Create failed: ${result.outcome}`);
    questIds.push(result.quest.id);

    expect((await getParticipation(result.quest.id, outsiderCookie)).status).toBe(404);
    expect((await getParticipation(result.quest.id)).status).toBe(404);
  });

  it('returns exactly the participation fields and no Finance internals', async () => {
    const assignedQuest = await createPublishedQuest();
    await assign(assignedQuest);
    await setQuestState(assignedQuest, questStatus.assigned);

    const body = (await (await getParticipation(assignedQuest)).json()) as {
      data: Record<string, unknown>;
    };

    expect(Object.keys(body.data).sort()).toEqual([
      'activeWorkerCount',
      'assignment',
      'capabilities',
      'condition',
      'description',
      'dueAt',
      'headcount',
      'hirerName',
      'id',
      'images',
      'locations',
      'mode',
      'participation',
      'proofRequired',
      'questReward',
      'startTime',
      'state',
      'tag',
      'title',
    ]);
    expect(Object.keys(body.data.capabilities as object)).toEqual(['canViewOnly']);
  });

  it('publishes the Participation Detail operation in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };
    const operation = document.paths['/api/v2/quests/{questId}/participation']?.get;

    expect(operation?.operationId).toBe('getQuestV2ParticipationDetail');
    expect(operation?.security).toBeDefined();
  });
});
