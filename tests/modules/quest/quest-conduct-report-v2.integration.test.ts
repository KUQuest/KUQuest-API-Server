import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminConductReport } from '@/database/schema/admin.schema';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2CompletionConfirmation,
  questV2ProofSubmission,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { auth } from '@/modules/auth';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';

const member = (name: string) => ({
  id: randomUUID(),
  email: `conduct-v2-${name}-${randomUUID()}@ku.th`,
  firstName: 'Conduct',
  lastName: name,
});
const hirer = member('Hirer');
const worker = member('Worker');
const secondWorker = member('SecondWorker');
const unrelated = member('Unrelated');
const members = [hirer, worker, secondWorker, unrelated];
const tagId = randomUUID();
const questIds: string[] = [];
const hour = 60 * 60 * 1000;

let databaseReady = false;

const request = (
  method: string,
  path: string,
  memberId?: string,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(memberId ? { 'x-member-id': memberId } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

const jsonBody = async (response: Response) =>
  (await response.json()) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };

const reportsPath = (questId: string) => `/api/v2/quests/${questId}/conduct-reports`;
const key = (name: string) => `conduct-v2-${name}-${randomUUID()}`;

const file = (
  filerId: string,
  questId: string,
  body: Record<string, unknown>,
  idempotencyKey = key('file')
) => request('POST', reportsPath(questId), filerId, body, { 'idempotency-key': idempotencyKey });

const readView = async (memberId: string, questId: string) => {
  const response = await request('GET', reportsPath(questId), memberId);
  expect(response.status).toBe(200);
  return (await jsonBody(response)).data as {
    windowEndsAt: string | null;
    reportable: Array<{ memberId: string; reason: string }>;
    items: Array<Record<string, unknown>>;
  };
};

type QuestShape = {
  status?:
    'QUEST_OPEN' | 'QUEST_ASSIGNED' | 'QUEST_IN_PROGRESS' | 'QUEST_FAILED' | 'QUEST_COMPLETED';
  mode?: 'FIRST_COME_FIRST_SERVED' | 'CANDIDATE';
  participation?: 'SINGLE' | 'GROUP';
  workerIds?: string[];
  dueAt?: Date;
  terminalAt?: Date;
  cancelledWorkerIds?: string[];
};

const createQuest = async ({
  status = 'QUEST_FAILED',
  mode = 'FIRST_COME_FIRST_SERVED',
  participation = 'SINGLE',
  workerIds = [worker.id],
  dueAt = new Date(Date.now() - hour),
  terminalAt = new Date(Date.now() - 1_000),
  cancelledWorkerIds = [],
}: QuestShape = {}) => {
  const questId = randomUUID();
  questIds.push(questId);
  const group = participation === 'GROUP';
  await db.insert(quest).values({
    id: questId,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Conduct Report v2 Quest',
    condition: 'Complete the work',
    mode: mode === 'CANDIDATE' ? 'CANDIDATE' : 'NO_CANDIDATE',
    participation: group ? 'GROUP' : 'SOLO',
    v2Mode: mode,
    v2Participation: participation,
    rewardSatang: 1_000,
    questFundingTotalSatang: 1_000 * workerIds.length,
    tagId,
    headcount: workerIds.length,
    startTime: new Date(dueAt.getTime() - 2 * hour),
    dueAt,
    proofRequired: true,
    createdAt: new Date(dueAt.getTime() - 3 * hour),
    updatedAt: terminalAt,
    questStatus: status,
    failedAt: status === 'QUEST_FAILED' ? terminalAt : null,
  });
  await db.insert(questAssignment).values(
    workerIds.map((workerId, index) => ({
      questId,
      workerId,
      assignmentStatus: cancelledWorkerIds.includes(workerId)
        ? 'ASSIGNMENT_CANCELLED'
        : status === 'QUEST_FAILED'
          ? 'ASSIGNMENT_INCOMPLETE'
          : status === 'QUEST_COMPLETED'
            ? 'ASSIGNMENT_COMPLETED'
            : 'ASSIGNMENT_ACTIVE',
      createdAt: new Date(dueAt.getTime() - 3 * hour + index * 1_000),
    }))
  );
  return questId;
};

const sendProof = (questId: string, workerId: string) =>
  db.insert(questV2ProofSubmission).values({
    questId,
    workerId,
    submittedByUserId: workerId,
    description: 'Done',
    submissionStatus: 'PROOF_NOT_APPROVED',
    sentAt: new Date(Date.now() - 2 * hour),
  });

const createSelectedTeam = async (questId: string, leaderId: string, memberIds: string[]) => {
  const [team] = await db
    .insert(questCandidateTeamV2)
    .values({
      questId,
      leaderId,
      name: 'Conduct Team',
      headcount: memberIds.length,
      state: 'TEAM_SELECTED',
    })
    .returning({ id: questCandidateTeamV2.id });
  if (!team) throw new Error('Team was not created');
  await db
    .insert(questCandidateTeamV2Member)
    .values(memberIds.map((memberId) => ({ teamId: team.id, memberId })));
  return team.id;
};

beforeAll(async () => {
  try {
    await sql`select 1`;
    const [tables] = await sql<{ conduct: string | null }[]>`
      select to_regclass('public.admin_conduct_reports') as conduct
    `;
    databaseReady = tables?.conduct !== null;
  } catch {
    console.warn('Skipping Conduct Report v2 tests: PostgreSQL is unavailable');
    return;
  }
  if (!databaseReady) return;
  await db.insert(authUser).values(members);
  await db.insert(tag).values({ id: tagId, name: `Conduct v2 tag ${tagId}` });
});

beforeEach(() => {
  spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
    const found = members.find(({ id }) => id === headers.get('x-member-id'));
    return found ? ({ user: found, session: { userId: found.id } } as never) : null;
  }) as never);
});

afterEach(async () => {
  mock.restore();
  if (!databaseReady || questIds.length === 0) return;
  await db.delete(adminConductReport).where(inArray(adminConductReport.questId, questIds));
  await db.delete(questV2ProofSubmission).where(inArray(questV2ProofSubmission.questId, questIds));
  await db
    .delete(questV2CompletionConfirmation)
    .where(inArray(questV2CompletionConfirmation.questId, questIds));
  await db.delete(quest).where(inArray(quest.id, questIds));
  questIds.splice(0, questIds.length);
});

afterAll(async () => {
  if (!databaseReady) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(
    inArray(
      authUser.id,
      members.map(({ id }) => id)
    )
  );
});

describe('Quest Conduct Report API v2 HTTP contract', () => {
  const questId = randomUUID();

  it('requires an Idempotency-Key to file', async () => {
    const response = await request('POST', reportsPath(questId), undefined, {
      reportedMemberId: worker.id,
      reason: 'CONDUCT_ABANDONED',
    });

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error?.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it.each([
    [{ reportedMemberId: worker.id, reason: 'CONDUCT_RUDE' }],
    [{ reportedMemberId: worker.id, reason: 'CONDUCT_ABANDONED', detail: '   ' }],
    [{ reportedMemberId: worker.id, reason: 'CONDUCT_ABANDONED', extra: true }],
  ])('validates the filing body %#', async (body) => {
    const response = await request('POST', reportsPath(questId), undefined, body, {
      'idempotency-key': key('validation'),
    });

    expect(response.status).toBe(400);
    expect((await jsonBody(response)).error?.code).toBe('VALIDATION');
  });

  it('requires Member authentication', async () => {
    const read = await request('GET', reportsPath(questId));
    const create = await request(
      'POST',
      reportsPath(questId),
      undefined,
      { reportedMemberId: worker.id, reason: 'CONDUCT_ABANDONED' },
      { 'idempotency-key': key('auth') }
    );

    expect(read.status).toBe(401);
    expect(create.status).toBe(401);
  });

  it('publishes both operations in OpenAPI', async () => {
    const document = (await (await request('GET', '/openapi/json')).json()) as {
      paths: Record<string, Record<string, { operationId?: string }> | undefined>;
    };
    const path = document.paths['/api/v2/quests/{questId}/conduct-reports'];

    expect(path?.get?.operationId).toBe('getQuestConductReportsV2');
    expect(path?.post?.operationId).toBe('createQuestConductReportV2');
  });
});

describe('Quest Conduct Report API v2 behavior', () => {
  it('lets the Hirer report a Worker who missed the work and shows the filed status', async () => {
    if (!databaseReady) return;
    const questId = await createQuest();

    const before = await readView(hirer.id, questId);
    expect(before.reportable).toEqual([{ memberId: worker.id, reason: 'CONDUCT_ABANDONED' }]);
    expect(before.items).toEqual([]);
    expect(before.windowEndsAt).not.toBeNull();

    const response = await file(hirer.id, questId, {
      reportedMemberId: worker.id,
      reason: 'CONDUCT_ABANDONED',
      detail: '  No work before the deadline  ',
    });
    expect(response.status).toBe(200);
    const created = (await jsonBody(response)).data;
    expect(created).toMatchObject({
      questId,
      reportedMemberId: worker.id,
      reason: 'CONDUCT_ABANDONED',
      detail: 'No work before the deadline',
      status: 'CONDUCT_REPORT_PENDING',
    });
    expect(created?.displayId).toMatch(/^CND-\d{6,}$/);

    const after = await readView(hirer.id, questId);
    expect(after.reportable).toEqual([]);
    expect(after.items).toEqual([expect.objectContaining({ id: created?.id })]);

    const [row] = await db
      .select()
      .from(adminConductReport)
      .where(eq(adminConductReport.id, created?.id as string));
    expect(row).toMatchObject({ filerUserId: hirer.id, status: 'CONDUCT_REPORT_PENDING' });

    const workerView = await readView(worker.id, questId);
    expect(workerView.items).toEqual([]);
    expect(workerView.reportable).toEqual([{ memberId: hirer.id, reason: 'CONDUCT_OUT_OF_SCOPE' }]);
  });

  it('replays a matching Idempotency-Key and rejects a second report on the same Member', async () => {
    if (!databaseReady) return;
    const questId = await createQuest();
    const body = { reportedMemberId: worker.id, reason: 'CONDUCT_ABANDONED' };
    const idempotencyKey = key('replay');

    const first = await jsonBody(await file(hirer.id, questId, body, idempotencyKey));
    const replay = await jsonBody(await file(hirer.id, questId, body, idempotencyKey));
    expect(replay.data?.id).toBe(first.data?.id as string);

    const reused = await file(
      hirer.id,
      questId,
      { ...body, detail: 'Different body' },
      idempotencyKey
    );
    expect(reused.status).toBe(409);
    expect((await jsonBody(reused)).error?.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const second = await file(hirer.id, questId, body);
    expect(second.status).toBe(409);
    expect((await jsonBody(second)).error?.code).toBe('CONDUCT_REPORT_ALREADY_EXISTS');
  });

  it('refuses CONDUCT_ABANDONED when the Worker sent a Proof Submission', async () => {
    if (!databaseReady) return;
    const questId = await createQuest();
    await sendProof(questId, worker.id);

    expect((await readView(hirer.id, questId)).reportable).toEqual([]);
    const response = await file(hirer.id, questId, {
      reportedMemberId: worker.id,
      reason: 'CONDUCT_ABANDONED',
    });
    expect(response.status).toBe(403);
    expect((await jsonBody(response)).error?.code).toBe('CONDUCT_REPORT_NOT_ALLOWED');
  });

  it('opens CONDUCT_ABANDONED only after dueAt but CONDUCT_OUT_OF_SCOPE from assignment', async () => {
    if (!databaseReady) return;
    const questId = await createQuest({
      status: 'QUEST_IN_PROGRESS',
      dueAt: new Date(Date.now() + hour),
    });

    const hirerView = await readView(hirer.id, questId);
    expect(hirerView.reportable).toEqual([]);
    expect(hirerView.windowEndsAt).toBeNull();
    expect((await readView(worker.id, questId)).reportable).toEqual([
      { memberId: hirer.id, reason: 'CONDUCT_OUT_OF_SCOPE' },
    ]);

    const response = await file(worker.id, questId, {
      reportedMemberId: hirer.id,
      reason: 'CONDUCT_OUT_OF_SCOPE',
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ['1 day after the Quest became Terminal', { terminalAt: new Date(Date.now() - 25 * hour) }],
    ['before QUEST_ASSIGNED', { status: 'QUEST_OPEN' as const }],
  ])('rejects filing %s', async (_name, shape) => {
    if (!databaseReady) return;
    const questId = await createQuest(shape);

    expect((await readView(hirer.id, questId)).reportable).toEqual([]);
    const response = await file(hirer.id, questId, {
      reportedMemberId: worker.id,
      reason: 'CONDUCT_ABANDONED',
    });
    expect(response.status).toBe(409);
    expect((await jsonBody(response)).error?.code).toBe('CONDUCT_REPORT_WINDOW_CLOSED');
  });

  it('hides the Quest from a Member who is not a participant', async () => {
    if (!databaseReady) return;
    const questId = await createQuest();

    const read = await request('GET', reportsPath(questId), unrelated.id);
    const create = await file(unrelated.id, questId, {
      reportedMemberId: worker.id,
      reason: 'CONDUCT_NO_SHOW',
    });
    expect(read.status).toBe(404);
    expect(create.status).toBe(404);
    expect((await jsonBody(create)).error?.code).toBe('QUEST_NOT_FOUND');
  });

  it('lists CONDUCT_NO_SHOW only for a GROUP + FIRST_COME_FIRST_SERVED peer who delivered nothing', async () => {
    if (!databaseReady) return;
    const questId = await createQuest({
      participation: 'GROUP',
      workerIds: [worker.id, secondWorker.id],
    });
    await db
      .insert(questV2CompletionConfirmation)
      .values({ questId, workerId: worker.id, confirmedByUserId: worker.id });

    expect((await readView(hirer.id, questId)).reportable).toEqual([
      { memberId: secondWorker.id, reason: 'CONDUCT_ABANDONED' },
    ]);
    expect((await readView(worker.id, questId)).reportable).toEqual([
      { memberId: hirer.id, reason: 'CONDUCT_OUT_OF_SCOPE' },
      { memberId: secondWorker.id, reason: 'CONDUCT_NO_SHOW' },
    ]);
    expect((await readView(secondWorker.id, questId)).reportable).toEqual([
      { memberId: hirer.id, reason: 'CONDUCT_OUT_OF_SCOPE' },
    ]);

    const response = await file(worker.id, questId, {
      reportedMemberId: secondWorker.id,
      reason: 'CONDUCT_NO_SHOW',
    });
    expect(response.status).toBe(200);
    expect((await readView(hirer.id, questId)).reportable).toEqual([]);
  });

  it('excludes a Worker whose Assignment was cancelled', async () => {
    if (!databaseReady) return;
    const questId = await createQuest({
      participation: 'GROUP',
      workerIds: [worker.id, secondWorker.id],
      cancelledWorkerIds: [secondWorker.id],
    });

    expect((await readView(hirer.id, questId)).reportable).toEqual([
      { memberId: worker.id, reason: 'CONDUCT_ABANDONED' },
    ]);
  });

  it('lets the Hirer report only the Team Leader on GROUP + CANDIDATE', async () => {
    if (!databaseReady) return;
    const questId = await createQuest({
      mode: 'CANDIDATE',
      participation: 'GROUP',
      workerIds: [worker.id, secondWorker.id],
    });
    const teamId = await createSelectedTeam(questId, worker.id, [worker.id, secondWorker.id]);

    expect((await readView(hirer.id, questId)).reportable).toEqual([
      { memberId: worker.id, reason: 'CONDUCT_ABANDONED' },
    ]);
    expect((await readView(worker.id, questId)).reportable).toEqual([
      { memberId: hirer.id, reason: 'CONDUCT_OUT_OF_SCOPE' },
    ]);
    const teammate = await file(hirer.id, questId, {
      reportedMemberId: secondWorker.id,
      reason: 'CONDUCT_ABANDONED',
    });
    expect(teammate.status).toBe(403);

    await db
      .insert(questV2CompletionConfirmation)
      .values({ questId, teamId, confirmedByUserId: worker.id });
    expect((await readView(hirer.id, questId)).reportable).toEqual([]);
  });
});
