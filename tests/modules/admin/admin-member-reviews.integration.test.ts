import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest, questAssignment, review } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { encodeCursor, MAX_PAGE_LIMIT } from '@/shared/cursor';

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { createStagingTestAuthRoute } from '../../fixtures/seeded-test-auth';

const adminEmail = `admin-member-reviews-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminMemberReviewsPass1!';
const memberAuthEmail = `admin-member-reviews-auth-${crypto.randomUUID()}@ku.th`;
const memberAuthPassword = 'MemberMemberReviewsPass1!';
const memberAuthApp = new Elysia({ name: 'admin-member-reviews-member-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: memberAuthEmail,
    password: memberAuthPassword,
    firstName: 'Session',
    lastName: 'Member',
  })
);

const revieweeId = crypto.randomUUID();
const emptyRevieweeId = crypto.randomUUID();
const reviewerOne = {
  id: crypto.randomUUID(),
  email: `admin-member-reviews-one-${crypto.randomUUID()}@ku.th`,
  firstName: 'Ari',
  lastName: 'Reviewer',
};
const reviewerTwo = {
  id: crypto.randomUUID(),
  email: `admin-member-reviews-two-${crypto.randomUUID()}@ku.th`,
  firstName: 'Bea',
  lastName: 'Reviewer',
};
const reviewerIds = [reviewerOne.id, reviewerTwo.id];
const questIds = [crypto.randomUUID(), crypto.randomUUID()];
const invalidQuestIds = [crypto.randomUUID(), crypto.randomUUID()];
const invalidReviewRows = [
  {
    id: crypto.randomUUID(),
    questId: invalidQuestIds[0]!,
    reviewerId: reviewerOne.id,
    rating: 2,
    comment: 'The Quest is not terminal.',
  },
  {
    id: crypto.randomUUID(),
    questId: invalidQuestIds[1]!,
    reviewerId: reviewerTwo.id,
    rating: 4,
    comment: 'The Reviewer has no Assignment.',
  },
];
const reviewRows = [
  {
    id: crypto.randomUUID(),
    questId: questIds[0]!,
    reviewerId: reviewerOne.id,
    rating: 5,
    comment: 'Clear communication.',
  },
  {
    id: crypto.randomUUID(),
    questId: questIds[0]!,
    reviewerId: reviewerTwo.id,
    rating: 3,
    comment: null,
  },
  {
    id: crypto.randomUUID(),
    questId: questIds[1]!,
    reviewerId: reviewerOne.id,
    rating: 5,
    comment: 'Delivered on time.',
  },
  {
    id: crypto.randomUUID(),
    questId: questIds[1]!,
    reviewerId: reviewerTwo.id,
    rating: 1,
    comment: 'Needs improvement.',
  },
];
const tagId = crypto.randomUUID();
const terminalAt = new Date('2026-09-20T00:00:00.000Z');
const reviewCreatedAt = new Date('2026-09-22T00:00:00.000Z');

type AdminMemberReviewsResponse = {
  success: boolean;
  data?: {
    items: Array<{
      id: string;
      rating: number;
      comment: string | null;
      createdAt: string;
      updatedAt: string;
      reviewer: { displayId: string; name: string };
      quest: { displayId: string; title: string; questStatus: string };
    }>;
    nextCursor: string | null;
    totalCount: number;
  };
  error?: { code: string; message: string };
};
let adminId = '';
let adminCookie = '';
let memberCookie = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const requestReviews = (id: string, query = '', cookie = adminCookie) =>
  app.handle(
    new Request(`http://localhost/api/v1/admin/members/${id}/reviews${query ? `?${query}` : ''}`, {
      headers: cookie ? { cookie } : undefined,
    })
  );

beforeAll(async () => {
  await sql`select 1`;

  await db.insert(authUser).values([
    {
      id: revieweeId,
      email: `${revieweeId}@ku.th`,
      firstName: 'Received',
      lastName: 'Reviews',
    },
    {
      id: emptyRevieweeId,
      email: `${emptyRevieweeId}@ku.th`,
      firstName: 'No',
      lastName: 'Reviews',
    },
    reviewerOne,
    reviewerTwo,
  ]);
  await db.insert(tag).values({ id: tagId, name: `Admin Member Reviews ${tagId}` });
  await db.insert(quest).values([
    {
      id: questIds[0]!,
      hirerId: revieweeId,
      title: 'Completed Quest for Reviews',
      condition: 'Complete the Quest work.',
      mode: 'NO_CANDIDATE',
      participation: 'GROUP',
      questStatus: 'QUEST_COMPLETED',
      rewardSatang: 2_000,
      tagId,
      headcount: 2,
      startTime: new Date('2026-09-19T00:00:00.000Z'),
      dueAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: terminalAt,
    },
    {
      id: questIds[1]!,
      hirerId: revieweeId,
      title: 'Failed Quest for Reviews',
      condition: 'Complete the Quest work.',
      mode: 'NO_CANDIDATE',
      participation: 'GROUP',
      questStatus: 'QUEST_FAILED',
      rewardSatang: 2_000,
      tagId,
      headcount: 2,
      startTime: new Date('2026-09-19T00:00:00.000Z'),
      dueAt: new Date('2026-09-20T00:00:00.000Z'),
      failedAt: terminalAt,
      updatedAt: terminalAt,
    },
  ]);
  await db.insert(quest).values([
    {
      id: invalidQuestIds[0]!,
      hirerId: revieweeId,
      title: 'Nonterminal Quest with a Review',
      condition: 'Complete the Quest work.',
      mode: 'NO_CANDIDATE',
      participation: 'SOLO',
      questStatus: 'QUEST_ASSIGNED',
      rewardSatang: 1_000,
      tagId,
      headcount: 1,
      startTime: new Date('2026-09-19T00:00:00.000Z'),
      dueAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: terminalAt,
    },
    {
      id: invalidQuestIds[1]!,
      hirerId: revieweeId,
      title: 'Terminal Quest with an Unassigned Reviewer',
      condition: 'Complete the Quest work.',
      mode: 'NO_CANDIDATE',
      participation: 'SOLO',
      questStatus: 'QUEST_COMPLETED',
      rewardSatang: 1_000,
      tagId,
      headcount: 1,
      startTime: new Date('2026-09-19T00:00:00.000Z'),
      dueAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: terminalAt,
    },
  ]);
  await db.insert(questAssignment).values({
    questId: invalidQuestIds[0]!,
    workerId: reviewerOne.id,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    startedAt: new Date('2026-09-19T00:00:00.000Z'),
  });
  await db.insert(questAssignment).values(
    questIds.flatMap((questId, index) =>
      reviewerIds.map((workerId) => ({
        questId,
        workerId,
        assignmentStatus: index === 0 ? 'ASSIGNMENT_COMPLETED' : 'ASSIGNMENT_INCOMPLETE',
        startedAt: new Date('2026-09-19T00:00:00.000Z'),
      }))
    )
  );
  await db.insert(review).values(
    reviewRows.map((row) => ({
      ...row,
      revieweeId,
      createdAt: reviewCreatedAt,
      updatedAt: new Date('2026-09-23T00:00:00.000Z'),
    }))
  );
  await db.insert(review).values(
    invalidReviewRows.map((row) => ({
      ...row,
      revieweeId,
      createdAt: reviewCreatedAt,
      updatedAt: new Date('2026-09-23T00:00:00.000Z'),
    }))
  );

  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Reviews Admin',
      firstName: 'Reviews',
      lastName: 'Admin',
    },
  });
  adminId = signUp.user.id;

  const adminLogin = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (adminLogin.status !== 200) throw new Error('Admin login failed.');
  adminCookie = getCookieHeader(adminLogin);

  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberAuthEmail, password: memberAuthPassword }),
    })
  );
  if (memberLogin.status !== 200) throw new Error('Member login failed.');
  memberCookie = getCookieHeader(memberLogin);
});

afterAll(async () => {
  await db.delete(review).where(inArray(review.questId, [...questIds, ...invalidQuestIds]));
  await db.delete(quest).where(inArray(quest.id, [...questIds, ...invalidQuestIds]));
  await db.delete(tag).where(eq(tag.id, tagId));
  await db
    .delete(authUser)
    .where(inArray(authUser.id, [revieweeId, emptyRevieweeId, ...reviewerIds]));
  if (adminId) await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
});

describe('Admin Member Reviews API', () => {
  it('lists received Reviews with Reviewer and Quest display IDs and current Quest State', async () => {
    const response = await requestReviews(revieweeId);
    expect(response.status).toBe(200);

    const body = (await response.json()) as AdminMemberReviewsResponse;
    expect(body.success).toBe(true);
    expect(body.data?.items).toHaveLength(4);
    expect(body.data?.totalCount).toBe(4);
    expect(body.data?.nextCursor).toBeNull();

    const completedReview = body.data?.items.find((item) => item.id === reviewRows[0]!.id);
    expect(completedReview).toMatchObject({
      rating: 5,
      comment: 'Clear communication.',
      createdAt: reviewCreatedAt.toISOString(),
      updatedAt: '2026-09-23T00:00:00.000Z',
      reviewer: { displayId: expect.stringMatching(/^MEM-\d{6,}$/), name: 'Ari Reviewer' },
      quest: {
        displayId: expect.stringMatching(/^QST-\d{6,}$/),
        title: 'Completed Quest for Reviews',
        questStatus: 'QUEST_COMPLETED',
      },
    });
    expect(completedReview?.reviewer).not.toHaveProperty('id');
    expect(completedReview?.quest).not.toHaveProperty('id');
    expect(completedReview).not.toHaveProperty('status');
  });
  it('excludes Reviews without a terminal Quest and an eligible Hirer/Worker pair', async () => {
    const response = await requestReviews(revieweeId);
    expect(response.status).toBe(200);

    const body = (await response.json()) as AdminMemberReviewsResponse;
    expect(body.data?.items).toHaveLength(4);
    expect(body.data?.totalCount).toBe(4);

    const returnedReviewIds = new Set<string>();
    for (const item of body.data?.items ?? []) returnedReviewIds.add(item.id);
    for (const invalidReview of invalidReviewRows) {
      expect(returnedReviewIds.has(invalidReview.id)).toBe(false);
    }
  });

  it('returns a zero-count page when the Member has no received Reviews', async () => {
    const response = await requestReviews(emptyRevieweeId);
    expect(response.status).toBe(200);

    const body = (await response.json()) as AdminMemberReviewsResponse;
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ items: [], nextCursor: null, totalCount: 0 });
  });

  it('applies the rating filter to both page items and totalCount', async () => {
    const query = new URLSearchParams({ rating: '5' }).toString();
    const response = await requestReviews(revieweeId, query);
    expect(response.status).toBe(200);

    const body = (await response.json()) as AdminMemberReviewsResponse;
    expect(body.data?.items).toHaveLength(2);
    expect(body.data?.totalCount).toBe(2);
    for (const item of body.data?.items ?? []) {
      expect(item.rating).toBe(5);
    }
  });

  it('pages through Reviews with equal timestamps exactly once in deterministic ID order', async () => {
    const itemIds: string[] = [];
    let cursor: string | null = null;

    for (let pageNumber = 0; pageNumber < 6; pageNumber += 1) {
      const query = new URLSearchParams({ limit: '1' });
      if (cursor) query.set('cursor', cursor);
      // Each cursor comes from the prior page, so requests and response reads stay sequential.
      // eslint-disable-next-line no-await-in-loop
      const response = await requestReviews(revieweeId, query.toString());
      expect(response.status).toBe(200);

      // eslint-disable-next-line no-await-in-loop
      const body = (await response.json()) as AdminMemberReviewsResponse;
      expect(body.data?.totalCount).toBe(4);
      for (const item of body.data?.items ?? []) itemIds.push(item.id);
      cursor = body.data?.nextCursor ?? null;
      if (cursor === null) break;
    }

    const expectedIds: string[] = [];
    for (const row of reviewRows) expectedIds.push(row.id);
    expectedIds.sort();
    expectedIds.reverse();
    expect(cursor).toBeNull();
    expect(itemIds).toEqual(expectedIds);
  });

  it('requires an enabled Admin Session and rejects a Member Session', async () => {
    const anonymous = await requestReviews(revieweeId, '', '');
    expect(anonymous.status).toBe(401);

    const member = await requestReviews(revieweeId, '', memberCookie);
    expect(member.status).toBe(403);
    const memberBody = (await member.json()) as AdminMemberReviewsResponse;
    expect(memberBody.error?.code).toBe('FORBIDDEN');

    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, adminId));
    try {
      const disabledAdmin = await requestReviews(revieweeId);
      expect(disabledAdmin.status).toBe(403);
      const disabledBody = (await disabledAdmin.json()) as AdminMemberReviewsResponse;
      expect(disabledBody.error?.code).toBe('ADMIN_DISABLED');
    } finally {
      await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
    }
  });

  it('returns the shared error for an unknown Member', async () => {
    const response = await requestReviews(crypto.randomUUID());
    expect(response.status).toBe(404);

    const body = (await response.json()) as AdminMemberReviewsResponse;
    expect(body.success).toBe(false);
    expect(body.error?.code).toBe('MEMBER_NOT_FOUND');
  });

  it('rejects malformed and missing Review cursors', async () => {
    const malformed = await requestReviews(
      revieweeId,
      new URLSearchParams({ cursor: 'not-valid-base64url!!' }).toString()
    );
    expect(malformed.status).toBe(400);
    const malformedBody = (await malformed.json()) as AdminMemberReviewsResponse;
    expect(malformedBody.error?.code).toBe('INVALID_CURSOR');

    const missingCursor = encodeCursor({
      startTime: reviewCreatedAt.toISOString(),
      id: crypto.randomUUID(),
    });
    const missing = await requestReviews(
      revieweeId,
      new URLSearchParams({ cursor: missingCursor }).toString()
    );
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as AdminMemberReviewsResponse;
    expect(missingBody.error?.code).toBe('INVALID_CURSOR');
    const ratingScopeCursor = encodeCursor({
      startTime: reviewCreatedAt.toISOString(),
      id: reviewRows[0]!.id,
      scope: 'MEMBER_REVIEW_ALL',
    });
    const ratingScopeMismatch = await requestReviews(
      revieweeId,
      new URLSearchParams({ rating: '5', cursor: ratingScopeCursor }).toString()
    );
    expect(ratingScopeMismatch.status).toBe(400);
    const ratingScopeMismatchBody =
      (await ratingScopeMismatch.json()) as AdminMemberReviewsResponse;
    expect(ratingScopeMismatchBody.error?.code).toBe('INVALID_CURSOR');

    const ratingAnchorCursor = encodeCursor({
      startTime: reviewCreatedAt.toISOString(),
      id: reviewRows[1]!.id,
      scope: 'MEMBER_REVIEW_5',
    });
    const ratingAnchorMismatch = await requestReviews(
      revieweeId,
      new URLSearchParams({ rating: '5', cursor: ratingAnchorCursor }).toString()
    );
    expect(ratingAnchorMismatch.status).toBe(400);
    const ratingAnchorMismatchBody =
      (await ratingAnchorMismatch.json()) as AdminMemberReviewsResponse;
    expect(ratingAnchorMismatchBody.error?.code).toBe('INVALID_CURSOR');
  });

  it('publishes the Admin Review route and response fields in OpenAPI', async () => {
    type OpenApiSchema = {
      type?: string;
      format?: string;
      pattern?: string;
      minimum?: number;
      maximum?: number;
      properties?: Record<string, OpenApiSchema>;
      items?: OpenApiSchema;
      anyOf?: OpenApiSchema[];
    };
    type OpenApiOperation = {
      operationId?: string;
      security?: unknown;
      parameters?: Array<{
        name?: string;
        in?: string;
        required?: boolean;
        schema?: OpenApiSchema;
      }>;
      responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
    };
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, OpenApiOperation>>;
      components?: { securitySchemes?: Record<string, unknown> };
    };

    expect(response.status).toBe(200);
    const operation = document.paths['/api/v1/admin/members/{id}/reviews']?.get;
    expect(operation?.operationId).toBe('listAdminMemberReviews');
    expect(operation?.security).toEqual([{ betterAuthAdminSession: [] }]);
    expect(document.components?.securitySchemes).toHaveProperty('betterAuthAdminSession');
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
    ]);

    const queryParameters = new Set<string>();
    let ratingSchema: OpenApiSchema | undefined;
    let ratingRequired: boolean | undefined;
    let limitSchema: OpenApiSchema | undefined;
    for (const parameter of operation?.parameters ?? []) {
      if (parameter.in !== 'query' || !parameter.name) continue;
      queryParameters.add(parameter.name);
      if (parameter.name === 'rating') ratingRequired = parameter.required;
      const alternatives = parameter.schema?.anyOf ?? [parameter.schema ?? {}];
      for (const alternative of alternatives) {
        if (alternative.type !== 'integer') continue;
        if (parameter.name === 'rating') ratingSchema = alternative;
        if (parameter.name === 'limit') limitSchema = alternative;
      }
    }
    expect(queryParameters).toEqual(new Set(['rating', 'limit', 'cursor']));
    expect(ratingRequired).toBe(false);
    expect(ratingSchema).toMatchObject({ type: 'integer', minimum: 1, maximum: 5 });
    expect(limitSchema).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: MAX_PAGE_LIMIT,
    });

    const responseSchema = operation?.responses?.['200']?.content?.['application/json']?.schema;
    const dataProperties = responseSchema?.properties?.data?.properties;
    expect(Object.keys(dataProperties ?? {}).sort()).toEqual(['items', 'nextCursor', 'totalCount']);
    let totalCountIntegerSchema: OpenApiSchema | undefined;
    const totalCountAlternatives = dataProperties?.totalCount?.anyOf ?? [
      dataProperties?.totalCount ?? {},
    ];
    for (const alternative of totalCountAlternatives) {
      if (alternative.type === 'integer') totalCountIntegerSchema = alternative;
    }
    expect(totalCountIntegerSchema).toMatchObject({ type: 'integer', minimum: 0 });
    const reviewProperties = dataProperties?.items?.items?.properties;
    expect(Object.keys(reviewProperties ?? {}).sort()).toEqual([
      'comment',
      'createdAt',
      'id',
      'quest',
      'rating',
      'reviewer',
      'updatedAt',
    ]);
    expect(reviewProperties).not.toHaveProperty('status');
    const reviewerProperties = reviewProperties?.reviewer?.properties;
    expect(Object.keys(reviewerProperties ?? {}).sort()).toEqual(['displayId', 'name']);
    expect(reviewerProperties?.displayId?.pattern).toBe('^MEM-[0-9]{6,}$');
    const questProperties = reviewProperties?.quest?.properties;
    expect(Object.keys(questProperties ?? {}).sort()).toEqual([
      'displayId',
      'questStatus',
      'title',
    ]);
    expect(questProperties?.displayId?.pattern).toBe('^QST-[0-9]{6,}$');
  });
});
