import { app } from '@/app';
import { db, sql } from '@/database/client';
import { applyQuestStateTransition } from '@/modules/quest/shared';
import { adminAction, adminDisputeCase } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  proofSubmission,
  proofSubmissionImage,
  quest,
  questApplication,
  questAssignment,
  questEditHistory,
  questEditRequest,
  questEditRequestResponse,
  questImage,
  questLocation,
  questTeam,
  questTeamMember,
  questV2EditRequest,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { ensureInitialMoneyPolicy } from '@/modules/wallet';
import { encodeCursor } from '@/shared/cursor';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const adminEmail = `quest-admin-route-${randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
let adminCookie = '';
let adminId = '';

const memberEmail = `quest-admin-member-${randomUUID()}@ku.th`;
const memberPassword = 'TestStudent1!';
const memberAuthApp = new Elysia({ name: 'quest-admin-member-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: memberEmail,
    password: memberPassword,
    firstName: 'Quest',
    lastName: 'Member',
  })
);
let memberCookie = '';

const hirerId = randomUUID();
const workerIds = [randomUUID(), randomUUID(), randomUUID()];
const studentIdFor = (userId: string): string => `KU-${userId.slice(0, 8)}`;
const tagId = randomUUID();
const questIds: string[] = [];
const questImageFileId = randomUUID();
const questImageId = randomUUID();
const disputeQuestId = randomUUID();
const disputeCaseIds = [randomUUID(), randomUUID()] as const;
const detailStateChangedAt = new Date('2030-06-03T01:00:00.000Z');
const timelineReasonChangedAt = new Date('2030-06-08T01:00:00.000Z');
const timelineReasonQuestId = randomUUID();

let openQuestId = '';
let hiddenQuestId = '';
let detailQuestId = '';
let teamQuestId = '';
let v2QuestId = '';
let applicationId = '';
let assignmentId = '';
let proofId = '';
let fileId = '';
let editRequestId = '';
let teamId = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

const adminRequest = (path: string) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: adminCookie },
    })
  );

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  await db.insert(authUser).values([
    {
      id: hirerId,
      email: `${hirerId}@ku.th`,
      firstName: 'Admin',
      lastName: 'Hirer',
      studentId: studentIdFor(hirerId),
    },
    ...workerIds.map((id, index) => ({
      id,
      email: `${id}@ku.th`,
      firstName: 'Admin',
      lastName: `Worker ${index}`,
      studentId: studentIdFor(id),
    })),
  ]);
  await db.insert(tag).values({ id: tagId, name: `Admin quest test ${tagId}` });

  const seedAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Quest Admin',
      firstName: 'Quest',
      lastName: 'Admin',
    },
  });
  const loginResponse = await app.handle(
    new Request('http://localhost/api/admin/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    })
  );
  if (loginResponse.status !== 200) throw new Error('Admin test session could not be created.');
  adminCookie = getCookieHeader(loginResponse);
  const [admin] = await db
    .select({ id: authAdmin.id })
    .from(authAdmin)
    .where(eq(authAdmin.email, adminEmail));
  adminId = admin!.id;

  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    })
  );
  if (memberLogin.status !== 200)
    throw new Error(`Member authentication failed: ${memberLogin.status}`);
  memberCookie = getCookieHeader(memberLogin);

  openQuestId = randomUUID();
  questIds.push(openQuestId);
  await db.insert(quest).values({
    id: openQuestId,
    hirerId,
    title: 'Open list quest',
    condition: 'Do the work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-06-01T00:00:00.000Z'),
  });

  hiddenQuestId = randomUUID();
  questIds.push(hiddenQuestId);
  await db.insert(quest).values({
    id: hiddenQuestId,
    hirerId,
    title: 'Hidden list quest',
    condition: 'Do the work',
    mode: 'CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-06-02T00:00:00.000Z'),
    hiddenAt: new Date(),
    hiddenByAdminId: adminId,
  });

  detailQuestId = randomUUID();
  questIds.push(detailQuestId);
  await db.insert(quest).values({
    id: detailQuestId,
    hirerId,
    title: 'Detail facet quest',
    description: 'Full facet quest for Admin detail read.',
    condition: 'Deliver the artifact',
    mode: 'CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_ASSIGNED',

    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-06-03T00:00:00.000Z'),
  });
  await db.insert(questLocation).values({
    questId: detailQuestId,
    label: 'Engineering Building',
  });

  applicationId = randomUUID();
  await db.insert(questApplication).values({
    id: applicationId,
    questId: detailQuestId,
    workerId: workerIds[0]!,
    applicationStatus: 'APPLICATION_SELECTED',
  });

  assignmentId = randomUUID();
  await db.insert(questAssignment).values({
    id: assignmentId,
    questId: detailQuestId,
    workerId: workerIds[0]!,
    assignmentStatus: 'ASSIGNMENT_ACTIVE',
    startedAt: new Date('2030-06-03T01:00:00.000Z'),
  });

  const detailStateTransitionApplied = await db.transaction((transaction) =>
    applyQuestStateTransition(transaction, {
      questId: detailQuestId,
      from: 'QUEST_ASSIGNED',
      to: 'QUEST_IN_PROGRESS',
      actor: { actorType: 'MEMBER', actorUserId: workerIds[0]! },
      now: detailStateChangedAt,
      workChat: [],
    })
  );
  if (!detailStateTransitionApplied)
    throw new Error('Admin Quest test timeline transition failed.');

  fileId = randomUUID();
  await db.insert(file).values({
    id: fileId,
    bucket: 'test-bucket',
    objectKey: `admin-quest-test/${fileId}`,
    contentType: 'image/png',
    sizeBytes: 2048,
    uploadedByUserId: workerIds[0]!,
  });

  await db.insert(file).values({
    id: questImageFileId,
    bucket: 'test-bucket',
    objectKey: `admin-quest-image/${questImageFileId}`,
    contentType: 'image/png',
    sizeBytes: 1024,
    uploadedByUserId: hirerId,
  });
  await db.insert(questImage).values({
    id: questImageId,
    questId: detailQuestId,
    fileId: questImageFileId,
    position: 0,
  });

  proofId = randomUUID();
  await db.insert(proofSubmission).values({
    id: proofId,
    questId: detailQuestId,
    workerId: workerIds[0]!,
    submittedByUserId: workerIds[0]!,
    content: 'Finished the deliverable.',
    submissionStatus: 'PROOF_PENDING',
  });
  await db.insert(proofSubmissionImage).values({ proofSubmissionId: proofId, fileId, position: 0 });

  await db.insert(questEditHistory).values({
    questId: detailQuestId,
    fieldName: 'description',
    oldValue: 'Old description',
    newValue: 'Full facet quest for Admin detail read.',
    editedByUserId: hirerId,
  });

  editRequestId = randomUUID();
  await db.insert(questEditRequest).values({
    id: editRequestId,
    questId: detailQuestId,
    requestedByUserId: hirerId,
    proposedChanges: { dueAt: '2030-06-10T00:00:00.000Z' },
    previousQuestStatus: 'QUEST_IN_PROGRESS',
    requestStatus: 'EDIT_REQUEST_APPROVED',
    resolvedAt: new Date(),
  });
  await db.insert(questEditRequestResponse).values({
    requestId: editRequestId,
    userId: workerIds[0]!,
    decision: 'EDIT_RESPONSE_APPROVED',
    respondedAt: new Date(),
  });

  await db.insert(adminAction).values({
    adminId,
    action: 'QUEST_REVIEW_NOTE',
    resourceType: 'quest',
    resourceId: detailQuestId,
    requestKey: `admin-quest-test-${detailQuestId}`,
    requestHash: 'a'.repeat(64),
    reasonCatalogVersion: 1,
    reasonCode: 'POLICY_REVIEW',
    metadata: {},
    resultData: {},
  });

  questIds.push(timelineReasonQuestId);
  await db.insert(quest).values({
    id: timelineReasonQuestId,
    hirerId,
    title: 'Quest State timeline with a reason code',
    condition: 'Complete the work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-06-08T00:00:00.000Z'),
  });
  const reasonTransitionApplied = await db.transaction((transaction) =>
    applyQuestStateTransition(transaction, {
      questId: timelineReasonQuestId,
      from: 'QUEST_OPEN',
      to: 'QUEST_CANCELLED',
      actor: { actorType: 'ADMIN', actorAdminId: adminId },
      reasonCode: 'POLICY_REVIEW',
      now: timelineReasonChangedAt,
      columns: { cancelledByAdminId: adminId },
      workChat: [],
    })
  );
  if (!reasonTransitionApplied) throw new Error('Admin Quest test timeline transition failed.');

  teamQuestId = randomUUID();
  questIds.push(teamQuestId);
  await db.insert(quest).values({
    id: teamQuestId,
    hirerId,
    title: 'Team facet quest',
    condition: 'Deliver as a team',
    mode: 'CANDIDATE',
    participation: 'GROUP',
    questStatus: 'QUEST_ASSIGNED',
    rewardSatang: 1_000,
    headcount: 2,
    tagId,
    startTime: new Date('2030-06-04T00:00:00.000Z'),
  });
  teamId = randomUUID();
  await db.insert(questTeam).values({
    id: teamId,
    questId: teamQuestId,
    leaderId: workerIds[1]!,
    name: 'Team Facet',
    teamStatus: 'TEAM_SELECTED',
  });
  await db.insert(questTeamMember).values([
    { teamId, userId: workerIds[1]! },
    { teamId, userId: workerIds[2]! },
  ]);

  v2QuestId = randomUUID();
  questIds.push(v2QuestId);
  await db.insert(quest).values({
    id: v2QuestId,
    hirerId,
    apiVersion: 'v2',
    title: 'V2 edit request quest',
    condition: 'Deliver v2 work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    v2Mode: 'FIRST_COME_FIRST_SERVED',
    v2Participation: 'SINGLE',
    questStatus: 'QUEST_OPEN',
    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-06-05T00:00:00.000Z'),
  });
  await db.insert(questV2EditRequest).values({
    questId: v2QuestId,
    previousCondition: { text: 'Deliver v2 work', items: [] },
    proposedCondition: { text: 'Deliver v2 work, revised', items: [] },
    requestStatus: 'EDIT_REQUEST_APPLIED',
    expiresAt: new Date('2030-06-06T00:00:00.000Z'),
    appliedAt: new Date('2030-06-05T12:00:00.000Z'),
  });
  questIds.push(disputeQuestId);
  await db.insert(quest).values({
    id: disputeQuestId,
    hirerId,
    title: 'Failed Quest with multiple Dispute Cases',
    condition: 'Complete the work',
    mode: 'CANDIDATE',
    participation: 'SOLO',
    questStatus: 'QUEST_FAILED',
    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-06-06T00:00:00.000Z'),
    failedAt: new Date('2030-06-07T00:00:00.000Z'),
  });
  await db.insert(questAssignment).values({
    questId: disputeQuestId,
    workerId: workerIds[0]!,
    assignmentStatus: 'ASSIGNMENT_INCOMPLETE',
  });
  await db.insert(adminDisputeCase).values([
    { id: disputeCaseIds[0], questId: disputeQuestId, filerUserId: hirerId },
    {
      id: disputeCaseIds[1],
      questId: disputeQuestId,
      filerUserId: workerIds[0]!,
      openedByAdminId: adminId,
    },
  ]);
});

afterAll(async () => {
  if (questIds.length === 0) return;
  await db.delete(quest).where(inArray(quest.id, questIds));
});

describe('Admin Quest API routes', () => {
  it('requires Admin authentication for Admin Quest endpoints', async () => {
    const list = await app.handle(new Request('http://localhost/api/v1/admin/quests'));
    const detail = await app.handle(
      new Request(`http://localhost/api/v1/admin/quests/${randomUUID()}`)
    );
    const command = await app.handle(
      new Request(`http://localhost/api/v1/admin/quests/${randomUUID()}/hide`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'admin-auth-check',
          'if-match': '1',
        },
        body: JSON.stringify({ reasonCode: 'POLICY_REVIEW' }),
      })
    );

    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
    expect(command.status).toBe(401);
  });

  it('rejects a Member Session on Admin Quest endpoints', async () => {
    const list = await app.handle(
      new Request('http://localhost/api/v1/admin/quests', {
        headers: { cookie: memberCookie },
      })
    );
    const detail = await app.handle(
      new Request(`http://localhost/api/v1/admin/quests/${openQuestId}`, {
        headers: { cookie: memberCookie },
      })
    );

    expect(list.status).toBe(403);
    expect(detail.status).toBe(403);
  });

  it('publishes the Admin Quest contract in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    type OpenApiSchema = {
      required?: string[];
      properties?: Record<string, OpenApiSchema>;
      items?: OpenApiSchema;
    };
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            security?: unknown;
            responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
          }
        >
      >;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/admin/quests']?.get?.operationId).toBe('listAdminQuests');
    expect(document.paths['/api/v1/admin/quests/{questId}']?.get?.operationId).toBe(
      'getAdminQuestDetail'
    );
    const detailDataSchema =
      document.paths['/api/v1/admin/quests/{questId}']?.get?.responses?.['200']?.content?.[
        'application/json'
      ]?.schema?.properties?.data;
    expect(detailDataSchema?.required).toEqual(
      expect.arrayContaining(['displayId', 'images', 'timeline', 'disputeCases'])
    );
    expect(detailDataSchema?.properties?.hirer?.required).toContain('studentId');
    expect(detailDataSchema?.properties?.images?.items?.required).toEqual([
      'imageId',
      'fileId',
      'position',
      'url',
      'urlExpiresAt',
    ]);
    expect(detailDataSchema?.properties?.timeline?.items?.required).toEqual([
      'id',
      'fromState',
      'toState',
      'changedAt',
      'actor',
      'reasonCode',
    ]);
  });

  it('returns 404 for a Quest that does not exist', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${randomUUID()}`);
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('QUEST_NOT_FOUND');
  });

  it('lists Quests across states with filters, hidden visibility, and cursor pagination', async () => {
    type ListResponse = {
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    };

    const openOnly = await adminRequest(
      '/api/v1/admin/quests?status=QUEST_OPEN&hidden=false&limit=50'
    );
    const openBody = (await openOnly.json()) as ListResponse;
    expect(openOnly.status).toBe(200);
    expect(openBody.data.items).not.toHaveLength(0);
    expect(openBody.data.items[0]?.displayId).toEqual(expect.stringMatching(/^QST-\d{6,}$/));
    expect(openBody.data.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([openQuestId, v2QuestId])
    );
    expect(openBody.data.items.every((item) => item.questStatus === 'QUEST_OPEN')).toBe(true);

    const hiddenOnly = await adminRequest('/api/v1/admin/quests?hidden=true&limit=50');
    const hiddenBody = (await hiddenOnly.json()) as ListResponse;
    expect(hiddenOnly.status).toBe(200);
    expect(hiddenBody.data.items.map((item) => item.id)).toContain(hiddenQuestId);
    expect(hiddenBody.data.items.every((item) => item.hiddenAt !== null)).toBe(true);

    const firstPage = await adminRequest(
      '/api/v1/admin/quests?status=QUEST_OPEN&hidden=false&limit=1&sort=newest'
    );
    const firstPageBody = (await firstPage.json()) as ListResponse;
    expect(firstPage.status).toBe(200);
    expect(firstPageBody.data.items).toHaveLength(1);
    expect(firstPageBody.data.nextCursor).toBeString();

    const secondPage = await adminRequest(
      `/api/v1/admin/quests?status=QUEST_OPEN&hidden=false&limit=1&sort=newest&cursor=${encodeURIComponent(firstPageBody.data.nextCursor!)}`
    );
    const secondPageBody = (await secondPage.json()) as ListResponse;
    expect(secondPage.status).toBe(200);
    expect(secondPageBody.data.items).toHaveLength(1);
    expect(new Set([openQuestId, v2QuestId])).toEqual(
      new Set([
        firstPageBody.data.items[0]?.id as string,
        secondPageBody.data.items[0]?.id as string,
      ])
    );

    const invalidCursor = await adminRequest('/api/v1/admin/quests?cursor=not-valid-base64url!!');
    expect(invalidCursor.status).toBe(400);
  });

  it('traverses microsecond-tied Quests exactly once in both sort directions and rejects a deleted cursor anchor', async () => {
    type ListResponse = {
      success: boolean;
      data: { items: Array<{ id: string }>; nextCursor: string | null };
    };

    const token = `cursor-ms-${randomUUID()}`;
    const seedQuestAt = async (createdAt: string): Promise<string> => {
      const id = randomUUID();
      questIds.push(id);
      await sql`
        insert into quest
          (id, hirer_id, title, "condition", mode, participation, quest_status,
           reward_satang, tag_id, start_time, created_at)
        values (
          ${id}, ${hirerId}, ${`Microsecond cursor quest ${token}`}, ${'Do the work'},
          'NO_CANDIDATE', 'SOLO', 'QUEST_OPEN', 1000, ${tagId},
          '2030-09-01T00:00:00Z', ${createdAt}::timestamptz
        )
      `;
      return id;
    };

    const first = await seedQuestAt('2030-09-01T00:00:00.100200Z');
    const tieFirst = await seedQuestAt('2030-09-01T00:00:00.100800Z');
    const tieSecond = await seedQuestAt('2030-09-01T00:00:00.100800Z');
    const last = await seedQuestAt('2030-09-01T00:00:00.101400Z');
    const tieAscending = [tieFirst, tieSecond].sort((left, right) => (left < right ? -1 : 1));

    const readEveryPage = async (sort: 'newest' | 'oldest'): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const params = new URLSearchParams({ q: token, sort, limit: '1' });
        if (cursor) params.set('cursor', cursor);
        // Each page cursor comes from the previous response, so these requests
        // must remain sequential.
        // eslint-disable-next-line no-await-in-loop
        const response = await adminRequest(`/api/v1/admin/quests?${params.toString()}`);
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = (await response.json()) as ListResponse;
        expect(body.success).toBe(true);
        ids.push(...body.data.items.map((item) => item.id));
        cursor = body.data.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      return ids;
    };

    expect(await readEveryPage('oldest')).toEqual([first, ...tieAscending, last]);
    expect(await readEveryPage('newest')).toEqual([last, ...tieAscending.reverse(), first]);

    // A Quest can be deleted while a client still holds its cursor. The list
    // must reject the stale anchor instead of returning a silent empty page.
    await db.delete(quest).where(eq(quest.id, first));
    const staleCursor = encodeCursor({
      id: first,
      startTime: '2030-09-01T00:00:00.100200Z',
    });
    const staleResponse = await adminRequest(
      `/api/v1/admin/quests?cursor=${encodeURIComponent(staleCursor)}`
    );
    const staleBody = (await staleResponse.json()) as {
      success: boolean;
      error?: { code: string; message: string };
    };
    expect(staleResponse.status).toBe(400);
    expect(staleBody.success).toBe(false);
    expect(staleBody.error?.code).toBe('INVALID_CURSOR');
  });

  it('searches Quest title and description within the Admin filter scope', async () => {
    type ListResponse = {
      data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
    };

    const byTitle = await adminRequest('/api/v1/admin/quests?q=Hidden%20list%20quest&limit=50');
    const byTitleBody = (await byTitle.json()) as ListResponse;
    expect(byTitle.status).toBe(200);
    expect(byTitleBody.data.items.map((item) => item.id)).toContain(hiddenQuestId);
    expect(byTitleBody.data.items.map((item) => item.id)).not.toContain(openQuestId);

    const byDescription = await adminRequest(
      '/api/v1/admin/quests?q=Full%20facet%20quest&limit=50'
    );
    const byDescriptionBody = (await byDescription.json()) as ListResponse;
    expect(byDescription.status).toBe(200);
    expect(byDescriptionBody.data.items.map((item) => item.id)).toContain(detailQuestId);

    const withFilter = await adminRequest(
      '/api/v1/admin/quests?q=list%20quest&hidden=false&limit=50'
    );
    const withFilterBody = (await withFilter.json()) as ListResponse;
    expect(withFilter.status).toBe(200);
    expect(withFilterBody.data.items.map((item) => item.id)).toContain(openQuestId);
    expect(withFilterBody.data.items.map((item) => item.id)).not.toContain(hiddenQuestId);

    const wildcard = await adminRequest('/api/v1/admin/quests?q=%25&limit=50');
    const wildcardBody = (await wildcard.json()) as ListResponse;
    expect(wildcard.status).toBe(200);
    expect(wildcardBody.data.items.map((item) => item.id)).not.toContain(openQuestId);
  });

  it('reads full Quest detail facets for Admin review', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${detailQuestId}`);
    const body = (await response.json()) as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      id: detailQuestId,
      displayId: expect.stringMatching(/^QST-\d{6,}$/),
      questStatus: 'QUEST_IN_PROGRESS',
      description: 'Full facet quest for Admin detail read.',
      hirer: {
        id: hirerId,
        studentId: studentIdFor(hirerId),
        firstName: 'Admin',
        lastName: 'Hirer',
        email: `${hirerId}@ku.th`,
      },
      locations: [{ label: 'Engineering Building' }],
      timeline: [
        {
          fromState: 'QUEST_ASSIGNED',
          toState: 'QUEST_IN_PROGRESS',
          changedAt: '2030-06-03T01:00:00.000Z',
          actor: { type: 'MEMBER', id: workerIds[0] },
          reasonCode: null,
        },
      ],
    });
    expect(body.data.images).toHaveLength(1);
    const image = body.data.images[0] as {
      imageId: string;
      fileId: string;
      position: number;
      url: string;
      urlExpiresAt: string;
    };
    expect(image.imageId).toBe(questImageId);
    expect(image.fileId).toBe(questImageFileId);
    expect(image.position).toBe(0);
    expect(image.url).toMatch(/^https?:\/\//);
    expect(image.urlExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const imageUrlExpiresAt = Date.parse(image.urlExpiresAt);
    expect(imageUrlExpiresAt).toBeGreaterThan(Date.now());
    expect(imageUrlExpiresAt).toBeLessThan(Date.now() + 16 * 60 * 1000);

    expect(body.data.candidates.applications).toEqual([
      expect.objectContaining({
        id: applicationId,
        applicationStatus: 'APPLICATION_SELECTED',
        worker: expect.objectContaining({
          id: workerIds[0],
          studentId: studentIdFor(workerIds[0]!),
          firstName: 'Admin',
          lastName: 'Worker 0',
          email: `${workerIds[0]}@ku.th`,
        }),
      }),
    ]);
    expect(body.data.assignments).toEqual([
      expect.objectContaining({
        id: assignmentId,
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
        worker: expect.objectContaining({
          id: workerIds[0],
          studentId: studentIdFor(workerIds[0]!),
          firstName: 'Admin',
          lastName: 'Worker 0',
          email: `${workerIds[0]}@ku.th`,
        }),
      }),
    ]);
    expect(body.data.proofSubmissions).toEqual([
      expect.objectContaining({
        id: proofId,
        submissionStatus: 'PROOF_PENDING',
        submittedBy: expect.objectContaining({
          id: workerIds[0],
          studentId: studentIdFor(workerIds[0]!),
          firstName: 'Admin',
          lastName: 'Worker 0',
          email: `${workerIds[0]}@ku.th`,
        }),
        worker: expect.objectContaining({
          id: workerIds[0],
          studentId: studentIdFor(workerIds[0]!),
        }),
        files: [expect.objectContaining({ fileId, contentType: 'image/png', sizeBytes: 2048 })],
      }),
    ]);
    expect(body.data.editHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'FIELD_EDIT',
          fieldName: 'description',
          editedByUserId: hirerId,
        }),
        expect.objectContaining({
          kind: 'EDIT_REQUEST',
          id: editRequestId,
          apiVersion: 'v1',
          requestStatus: 'EDIT_REQUEST_APPROVED',
          responses: [
            expect.objectContaining({ workerId: workerIds[0], decision: 'EDIT_RESPONSE_APPROVED' }),
          ],
        }),
      ])
    );
    expect(body.data.adminActions).toEqual([
      expect.objectContaining({
        action: 'QUEST_REVIEW_NOTE',
        reasonCode: 'POLICY_REVIEW',
        admin: expect.objectContaining({ id: adminId }),
      }),
    ]);
  });
  it('returns empty images, state timeline, and Dispute Case collections when none exist', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${openQuestId}`);
    const body = (await response.json()) as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data.images).toEqual([]);
    expect(body.data.timeline).toEqual([]);
    expect(body.data.disputeCases).toEqual([]);
  });
  it('returns an Admin actor and reason code in the Quest State timeline', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${timelineReasonQuestId}`);
    const body = (await response.json()) as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data.timeline).toEqual([
      expect.objectContaining({
        fromState: 'QUEST_OPEN',
        toState: 'QUEST_CANCELLED',
        changedAt: timelineReasonChangedAt.toISOString(),
        actor: { type: 'ADMIN', id: adminId },
        reasonCode: 'POLICY_REVIEW',
      }),
    ]);
  });

  it('returns all Dispute Cases linked to a failed Quest', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${disputeQuestId}`);
    const body = (await response.json()) as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data.disputeCases).toHaveLength(2);
    expect(body.data.disputeCases).toEqual(
      expect.arrayContaining(
        disputeCaseIds.map((id) =>
          expect.objectContaining({
            id,
            displayId: expect.stringMatching(/^DSP-\d{6,}$/),
            questId: disputeQuestId,
            status: 'DISPUTE_CASE_PENDING',
          })
        )
      )
    );
  });

  it('reads team candidates for a Group Quest', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${teamQuestId}`);
    const body = (await response.json()) as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data.candidates.teams).toEqual([
      expect.objectContaining({
        id: teamId,
        name: 'Team Facet',
        teamStatus: 'TEAM_SELECTED',
        leaderId: workerIds[1],
        members: expect.arrayContaining([
          expect.objectContaining({
            member: expect.objectContaining({
              id: workerIds[1],
              studentId: studentIdFor(workerIds[1]!),
              firstName: 'Admin',
              lastName: 'Worker 1',
              email: `${workerIds[1]}@ku.th`,
            }),
          }),
          expect.objectContaining({
            member: expect.objectContaining({
              id: workerIds[2],
              studentId: studentIdFor(workerIds[2]!),
              firstName: 'Admin',
              lastName: 'Worker 2',
              email: `${workerIds[2]}@ku.th`,
            }),
          }),
        ]),
      }),
    ]);
  });

  it('reads v2 edit requests in edit history', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${v2QuestId}`);
    const body = (await response.json()) as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data.editHistory).toEqual([
      expect.objectContaining({
        kind: 'EDIT_REQUEST',
        apiVersion: 'v2',
        requestStatus: 'EDIT_REQUEST_APPLIED',
        responses: [],
      }),
    ]);
  });
});
