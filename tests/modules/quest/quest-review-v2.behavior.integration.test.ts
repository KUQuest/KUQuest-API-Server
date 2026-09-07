import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questAssignment,
  review,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { auth } from '@/modules/auth';
import {
  createQuestV2Review,
  updateQuestV2Review,
} from '@/modules/quest/quest-review-v2.service';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const hirer = {
  id: randomUUID(),
  email: `review-v2-hirer-${randomUUID()}@ku.th`,
  firstName: 'Review',
  lastName: 'Hirer',
};
const worker = {
  id: randomUUID(),
  email: `review-v2-worker-${randomUUID()}@ku.th`,
  firstName: 'Review',
  lastName: 'Worker',
};
const secondWorker = {
  id: randomUUID(),
  email: `review-v2-worker-two-${randomUUID()}@ku.th`,
  firstName: 'Second',
  lastName: 'Worker',
};
const unrelated = {
  id: randomUUID(),
  email: `review-v2-unrelated-${randomUUID()}@ku.th`,
  firstName: 'Unrelated',
  lastName: 'Member',
};
const members = [hirer, worker, secondWorker, unrelated];
const tagId = randomUUID();
const questIds: string[] = [];
const terminalStatuses = ['QUEST_COMPLETED', 'QUEST_FAILED', 'QUEST_CANCELLED'] as const;
type TestQuestStatus = (typeof terminalStatuses)[number] | 'QUEST_IN_PROGRESS';

let postgresAvailable = false;
let reviewSchemaAvailable = false;

const authenticate = () => spyOn(auth.api, 'getSession').mockImplementation((async ({ headers }: { headers: Headers }) => {
  const member = members.find(({ id }) => id === headers.get('x-member-id'));
  if (!member) return null;
  return { user: member, session: { userId: member.id } } as never;
}) as never);

const request = (
  method: string,
  path: string,
  memberId: string,
  body?: unknown,
  headers: HeadersInit = {},
) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: {
    'x-member-id': memberId,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

const jsonBody = async (response: Response) => await response.json() as {
  success: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
};

const commandKey = (name: string, questId: string) => `review-v2-${name}-${questId}-${randomUUID()}`;

const createQuest = async (
  questStatus: TestQuestStatus,
  assignmentWorkerIds = [worker.id],
  overrides: Partial<typeof quest.$inferInsert> = {},
) => {
  const questId = randomUUID();
  questIds.push(questId);
  const group = assignmentWorkerIds.length > 1 || overrides.v2Participation === 'GROUP';
  const terminalAt = overrides.updatedAt instanceof Date
    ? overrides.updatedAt
    : new Date(Date.now() - 1_000);
  const assignmentStatus = questStatus === 'QUEST_COMPLETED'
    ? 'ASSIGNMENT_COMPLETED'
    : questStatus === 'QUEST_FAILED'
      ? 'ASSIGNMENT_INCOMPLETE'
      : questStatus === 'QUEST_CANCELLED'
        ? 'ASSIGNMENT_CANCELLED'
        : 'ASSIGNMENT_ACTIVE';

  await db.insert(quest).values({
    id: questId,
    hirerId: hirer.id,
    apiVersion: 'v2',
    title: 'Rating Review v2 behavior Quest',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: group ? 'GROUP' : 'SOLO',
    v2Mode: 'FIRST_COME_FIRST_SERVED',
    v2Participation: group ? 'GROUP' : 'SINGLE',
    rewardSatang: group ? 2_000 : 1_000,
    questFundingTotalSatang: group ? 2_000 : 1_000,
    tagId,
    headcount: group ? assignmentWorkerIds.length : 1,
    startTime: new Date(terminalAt.getTime() - 2 * 60 * 60 * 1000),
    dueAt: new Date(terminalAt.getTime() - 60 * 60 * 1000),
    proofRequired: true,
    createdAt: new Date(terminalAt.getTime() - 3 * 60 * 60 * 1000),
    updatedAt: terminalAt,
    ...overrides,
    questStatus,
    cancelledAt: questStatus === 'QUEST_CANCELLED' ? terminalAt : null,
  });
  await db.insert(questAssignment).values(assignmentWorkerIds.map((workerId) => ({
    questId,
    workerId,
    assignmentStatus,
    startedAt: new Date(terminalAt.getTime() - 2 * 60 * 60 * 1000),
    createdAt: new Date(terminalAt.getTime() - 2 * 60 * 60 * 1000),
  })));
  return questId;
};

const terminalStatusRows: Array<[typeof terminalStatuses[number]]> = terminalStatuses.map((status) => [status]);

beforeAll(async () => {
  try {
    await sql`select 1`;
    postgresAvailable = true;
    const [tables] = await sql<{ review: string | null; command: string | null }[]>`
      select
        to_regclass('public.review') as review,
        to_regclass('public.quest_v2_review_command') as command
    `;
    reviewSchemaAvailable = tables?.review !== null && tables?.command !== null;
  } catch {
    console.warn('Skipping Quest Review v2 behavior tests: PostgreSQL is unavailable');
    return;
  }
  if (!reviewSchemaAvailable) {
    console.warn('Skipping Quest Review v2 behavior tests: Review migrations are not applied');
    return;
  }
  await db.insert(authUser).values(members);
  await db.insert(tag).values({ id: tagId, name: `Review v2 behavior tag ${tagId}` });
});

beforeEach(() => {
  authenticate();
});

afterEach(async () => {
  mock.restore();
  if (!postgresAvailable || !reviewSchemaAvailable) return;
  if (questIds.length === 0) return;
  await db.delete(review).where(inArray(review.questId, questIds));
  await db.delete(quest).where(inArray(quest.id, questIds));
  questIds.splice(0, questIds.length);
});

afterAll(async () => {
  if (!postgresAvailable || !reviewSchemaAvailable) return;
  await db.delete(tag).where(eq(tag.id, tagId));
  await db.delete(authUser).where(inArray(authUser.id, members.map(({ id }) => id)));
});

describe('Quest Review API v2 behavior', () => {
  it.each(terminalStatusRows)('accepts a Review after %s and exposes it through Profile reads', async (questStatus) => {
    if (!postgresAvailable || !reviewSchemaAvailable) return;
    const questId = await createQuest(questStatus);

    const hirerReview = await request(
      'POST',
      `/api/v2/quests/${questId}/reviews`,
      hirer.id,
      { revieweeId: worker.id, rating: 5, comment: '  Good work  ' },
      { 'idempotency-key': commandKey('hirer', questId) },
    );
    expect(hirerReview.status).toBe(200);
    const hirerReviewBody = await jsonBody(hirerReview);
    expect(hirerReviewBody.data).toMatchObject({
      questId,
      reviewerId: hirer.id,
      revieweeId: worker.id,
      rating: 5,
      comment: 'Good work',
    });

    const workerReview = await request(
      'POST',
      `/api/v2/quests/${questId}/reviews`,
      worker.id,
      { rating: 4, comment: '  Clear communication  ' },
      { 'idempotency-key': commandKey('worker', questId) },
    );
    expect(workerReview.status).toBe(200);
    expect((await jsonBody(workerReview)).data).toMatchObject({
      questId,
      reviewerId: worker.id,
      revieweeId: hirer.id,
      rating: 4,
      comment: 'Clear communication',
    });

    const profileReviews = await request(
      'GET',
      `/api/v1/profile/${worker.id}/reviews`,
      hirer.id,
    );
    expect(profileReviews.status).toBe(200);
    const profileReviewsBody = await jsonBody(profileReviews);
    expect(profileReviewsBody.data?.items).toEqual([
      expect.objectContaining({
        id: hirerReviewBody.data?.id,
        rating: 5,
        comment: 'Good work',
        quest: { id: questId, title: 'Rating Review v2 behavior Quest' },
      }),
    ]);

    const reputation = await request('GET', '/api/v1/profile/reputation', worker.id);
    expect(reputation.status).toBe(200);
    expect((await jsonBody(reputation)).data).toMatchObject({
      rating: {
        average: 5,
        count: 1,
        distribution: { '5': 1, '4': 0, '3': 0, '2': 0, '1': 0 },
      },
    });
  });

  it('keeps GROUP Reviews pair-scoped and rejects Worker-to-Worker Reviews', async () => {
    if (!postgresAvailable || !reviewSchemaAvailable) return;
    const questId = await createQuest('QUEST_COMPLETED', [worker.id, secondWorker.id]);

    for (const [reviewerId, revieweeId, name] of [
      [hirer.id, worker.id, 'hirer-worker-one'],
      [hirer.id, secondWorker.id, 'hirer-worker-two'],
    ] as const) {
      const response = await request(
        'POST',
        `/api/v2/quests/${questId}/reviews`,
        reviewerId,
        { revieweeId, rating: 5 },
        { 'idempotency-key': commandKey(name, questId) },
      );
      expect(response.status).toBe(200);
    }

    for (const [reviewerId, name] of [[worker.id, 'worker-one'], [secondWorker.id, 'worker-two']] as const) {
      const response = await request(
        'POST',
        `/api/v2/quests/${questId}/reviews`,
        reviewerId,
        { rating: 4 },
        { 'idempotency-key': commandKey(name, questId) },
      );
      expect(response.status).toBe(200);
    }

    const workerToWorker = await request(
      'POST',
      `/api/v2/quests/${questId}/reviews`,
      worker.id,
      { revieweeId: secondWorker.id, rating: 1 },
      { 'idempotency-key': commandKey('worker-to-worker', questId) },
    );
    expect(workerToWorker.status).toBe(403);
    expect((await jsonBody(workerToWorker)).error?.code).toBe('REVIEW_NOT_ALLOWED');

    expect(await db.select({ id: review.id }).from(review).where(eq(review.questId, questId))).toHaveLength(4);
  });

  it('does not accept a Review before the Quest reaches a Terminal State', async () => {
    if (!postgresAvailable || !reviewSchemaAvailable) return;
    const questId = await createQuest('QUEST_IN_PROGRESS');

    const response = await request(
      'POST',
      `/api/v2/quests/${questId}/reviews`,
      hirer.id,
      { revieweeId: worker.id, rating: 5 },
      { 'idempotency-key': commandKey('before-terminal', questId) },
    );
    expect(response.status).toBe(409);
    expect((await jsonBody(response)).error?.code).toBe('QUEST_NOT_TERMINAL');
    expect(await db.select({ id: review.id }).from(review).where(eq(review.questId, questId))).toHaveLength(0);
  });

  it('replays a create, rejects key reuse, and keeps one direction under concurrency', async () => {
    if (!postgresAvailable || !reviewSchemaAvailable) return;
    const questId = await createQuest('QUEST_COMPLETED');
    const key = commandKey('replay', questId);
    const body = { revieweeId: worker.id, rating: 5, comment: 'Reliable' };

    const first = await request('POST', `/api/v2/quests/${questId}/reviews`, hirer.id, body, {
      'idempotency-key': key,
    });
    expect(first.status).toBe(200);
    const firstBody = await jsonBody(first);

    const replay = await request('POST', `/api/v2/quests/${questId}/reviews`, hirer.id, body, {
      'idempotency-key': key,
    });
    expect(replay.status).toBe(200);
    expect(await jsonBody(replay)).toEqual(firstBody);

    const reused = await request(
      'POST',
      `/api/v2/quests/${questId}/reviews`,
      hirer.id,
      { revieweeId: worker.id, rating: 4, comment: 'Changed' },
      { 'idempotency-key': key },
    );
    expect(reused.status).toBe(409);
    expect((await jsonBody(reused)).error?.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const concurrentQuestId = await createQuest('QUEST_COMPLETED');
    const concurrentResponses = await Promise.all([
      request(
        'POST',
        `/api/v2/quests/${concurrentQuestId}/reviews`,
        hirer.id,
        { revieweeId: worker.id, rating: 5 },
        { 'idempotency-key': commandKey('concurrent-one', concurrentQuestId) },
      ),
      request(
        'POST',
        `/api/v2/quests/${concurrentQuestId}/reviews`,
        hirer.id,
        { revieweeId: worker.id, rating: 4 },
        { 'idempotency-key': commandKey('concurrent-two', concurrentQuestId) },
      ),
    ]);
    expect(concurrentResponses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(await db.select({ id: review.id }).from(review).where(eq(review.questId, concurrentQuestId))).toHaveLength(1);
  });

  it('allows only the author to edit and recalculates Reputation immediately', async () => {
    if (!postgresAvailable || !reviewSchemaAvailable) return;
    const questId = await createQuest('QUEST_COMPLETED');
    const created = await request(
      'POST',
      `/api/v2/quests/${questId}/reviews`,
      hirer.id,
      { revieweeId: worker.id, rating: 5, comment: 'Initial' },
      { 'idempotency-key': commandKey('edit-create', questId) },
    );
    const createdBody = await jsonBody(created);
    const reviewId = createdBody.data?.id as string;

    const nonAuthor = await request(
      'PATCH',
      `/api/v2/quests/${questId}/reviews/${reviewId}`,
      worker.id,
      { rating: 1 },
      { 'idempotency-key': commandKey('edit-not-author', questId) },
    );
    expect(nonAuthor.status).toBe(403);
    expect((await jsonBody(nonAuthor)).error?.code).toBe('REVIEW_NOT_ALLOWED');

    const edited = await request(
      'PATCH',
      `/api/v2/quests/${questId}/reviews/${reviewId}`,
      hirer.id,
      { rating: 2, comment: '  Updated  ' },
      { 'idempotency-key': commandKey('edit-author', questId) },
    );
    expect(edited.status).toBe(200);
    const editedBody = await jsonBody(edited);
    expect(editedBody.data).toMatchObject({ rating: 2, comment: 'Updated' });

    const editKey = commandKey('edit-replay', questId);
    const replayedEdit = await request(
      'PATCH',
      `/api/v2/quests/${questId}/reviews/${reviewId}`,
      hirer.id,
      { rating: 3 },
      { 'idempotency-key': editKey },
    );
    expect(replayedEdit.status).toBe(200);
    const replayedEditBody = await jsonBody(replayedEdit);
    const editReplay = await request(
      'PATCH',
      `/api/v2/quests/${questId}/reviews/${reviewId}`,
      hirer.id,
      { rating: 3 },
      { 'idempotency-key': editKey },
    );
    expect(editReplay.status).toBe(200);
    expect(await jsonBody(editReplay)).toEqual(replayedEditBody);

    const editKeyReuse = await request(
      'PATCH',
      `/api/v2/quests/${questId}/reviews/${reviewId}`,
      hirer.id,
      { rating: 4 },
      { 'idempotency-key': editKey },
    );
    expect(editKeyReuse.status).toBe(409);
    expect((await jsonBody(editKeyReuse)).error?.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const reputation = await request('GET', '/api/v1/profile/reputation', worker.id);
    expect((await jsonBody(reputation)).data).toMatchObject({
      rating: {
        average: 3,
        count: 1,
        distribution: { '5': 0, '4': 0, '3': 1, '2': 0, '1': 0 },
      },
    });
  });

  it('allows editing at the seven-day boundary and rejects edits after it', async () => {
    if (!postgresAvailable || !reviewSchemaAvailable) return;
    const terminalAt = new Date('2030-01-01T00:00:00.000Z');
    const questId = await createQuest('QUEST_COMPLETED', [worker.id], { updatedAt: terminalAt });
    const created = await createQuestV2Review(
      hirer.id,
      questId,
      { revieweeId: worker.id, rating: 5 },
      commandKey('boundary-create', questId),
      new Date('2030-01-02T00:00:00.000Z'),
    );
    expect('outcome' in created).toBe(false);
    if ('outcome' in created) return;

    const deadline = new Date('2030-01-08T00:00:00.000Z');
    const allowed = await updateQuestV2Review(
      hirer.id,
      questId,
      created.id,
      { rating: 4 },
      commandKey('boundary-allowed', questId),
      deadline,
    );
    expect(allowed).toMatchObject({ id: created.id, rating: 4 });

    const expired = await updateQuestV2Review(
      hirer.id,
      questId,
      created.id,
      { rating: 3 },
      commandKey('boundary-expired', questId),
      new Date(deadline.getTime() + 1),
    );
    expect(expired).toEqual({ outcome: 'window-expired' });
  });
});
