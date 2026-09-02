import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
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
  questTeam,
  questTeamMember,
  questV2EditRequest,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { ensureInitialMoneyPolicy } from '@/modules/wallet';

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const adminEmail = `quest-admin-route-${randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
let adminCookie = '';
let adminId = '';

const hirerId = randomUUID();
const workerIds = [randomUUID(), randomUUID(), randomUUID()];
const tagId = randomUUID();
const questIds: string[] = [];

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
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const adminRequest = (path: string) => app.handle(new Request(`http://localhost${path}`, {
  headers: { cookie: adminCookie },
}));

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  await db.insert(authUser).values([
    { id: hirerId, email: `${hirerId}@ku.th`, firstName: 'Admin', lastName: 'Hirer' },
    ...workerIds.map((id, index) => ({ id, email: `${id}@ku.th`, firstName: 'Admin', lastName: `Worker ${index}` })),
  ]);
  await db.insert(tag).values({ id: tagId, name: `Admin quest test ${tagId}` });

  const seedAuth = createAdminAuth({ allowSignUp: true, autoSignIn: false, markEmailVerified: true });
  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Quest Admin',
      firstName: 'Quest',
      lastName: 'Admin',
    },
  });
  const loginResponse = await app.handle(new Request('http://localhost/api/admin/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  }));
  if (loginResponse.status !== 200) throw new Error('Admin test session could not be created.');
  adminCookie = getCookieHeader(loginResponse);
  const [admin] = await db.select({ id: authAdmin.id }).from(authAdmin).where(eq(authAdmin.email, adminEmail));
  adminId = admin!.id;

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
    questStatus: 'QUEST_HIDDEN',
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
    questStatus: 'QUEST_IN_PROGRESS',
    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-06-03T00:00:00.000Z'),
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

  fileId = randomUUID();
  await db.insert(file).values({
    id: fileId,
    bucket: 'test-bucket',
    objectKey: `admin-quest-test/${fileId}`,
    contentType: 'image/png',
    sizeBytes: 2048,
    uploadedByUserId: workerIds[0]!,
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
});

afterAll(async () => {
  if (questIds.length === 0) return;
  await db.delete(quest).where(inArray(quest.id, questIds));
});

describe('Admin Quest API routes', () => {
  it('requires Admin authentication for Admin Quest endpoints', async () => {
    const list = await app.handle(new Request('http://localhost/api/v1/admin/quests'));
    const detail = await app.handle(new Request(`http://localhost/api/v1/admin/quests/${randomUUID()}`));

    expect(list.status).toBe(401);
    expect(detail.status).toBe(401);
  });

  it('publishes the Admin Quest contract in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/admin/quests']?.get?.operationId).toBe('listAdminQuests');
    expect(document.paths['/api/v1/admin/quests/{questId}']?.get?.operationId).toBe('getAdminQuestDetail');
  });

  it('returns 404 for a Quest that does not exist', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${randomUUID()}`);
    const body = await response.json() as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('QUEST_NOT_FOUND');
  });

  it('lists Quests across states with filters, hidden visibility, and cursor pagination', async () => {
    type ListResponse = { data: { items: Array<Record<string, unknown>>; nextCursor: string | null } };

    const openOnly = await adminRequest('/api/v1/admin/quests?status=QUEST_OPEN&limit=50');
    const openBody = await openOnly.json() as ListResponse;
    expect(openOnly.status).toBe(200);
    expect(openBody.data.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([openQuestId, v2QuestId]),
    );
    expect(openBody.data.items.every((item) => item.questStatus === 'QUEST_OPEN')).toBe(true);

    const hiddenOnly = await adminRequest('/api/v1/admin/quests?hidden=true&limit=50');
    const hiddenBody = await hiddenOnly.json() as ListResponse;
    expect(hiddenOnly.status).toBe(200);
    expect(hiddenBody.data.items.map((item) => item.id)).toContain(hiddenQuestId);
    expect(hiddenBody.data.items.every((item) => item.hiddenAt !== null)).toBe(true);

    const firstPage = await adminRequest('/api/v1/admin/quests?status=QUEST_OPEN&limit=1&sort=newest');
    const firstPageBody = await firstPage.json() as ListResponse;
    expect(firstPage.status).toBe(200);
    expect(firstPageBody.data.items).toHaveLength(1);
    expect(firstPageBody.data.nextCursor).toBeString();

    const secondPage = await adminRequest(
      `/api/v1/admin/quests?status=QUEST_OPEN&limit=1&sort=newest&cursor=${encodeURIComponent(firstPageBody.data.nextCursor!)}`,
    );
    const secondPageBody = await secondPage.json() as ListResponse;
    expect(secondPage.status).toBe(200);
    expect(secondPageBody.data.items).toHaveLength(1);
    expect(new Set([openQuestId, v2QuestId])).toEqual(
      new Set([firstPageBody.data.items[0]?.id as string, secondPageBody.data.items[0]?.id as string]),
    );

    const invalidCursor = await adminRequest('/api/v1/admin/quests?cursor=not-valid-base64url!!');
    expect(invalidCursor.status).toBe(400);
  });

  it('reads full Quest detail facets for Admin review', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${detailQuestId}`);
    const body = await response.json() as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      id: detailQuestId,
      questStatus: 'QUEST_IN_PROGRESS',
      description: 'Full facet quest for Admin detail read.',
      hirer: expect.objectContaining({ id: hirerId }),
    });
    expect(body.data.candidates.applications).toEqual([
      expect.objectContaining({
        id: applicationId,
        applicationStatus: 'APPLICATION_SELECTED',
        worker: expect.objectContaining({ id: workerIds[0] }),
      }),
    ]);
    expect(body.data.assignments).toEqual([
      expect.objectContaining({
        id: assignmentId,
        assignmentStatus: 'ASSIGNMENT_ACTIVE',
        worker: expect.objectContaining({ id: workerIds[0] }),
      }),
    ]);
    expect(body.data.proofSubmissions).toEqual([
      expect.objectContaining({
        id: proofId,
        submissionStatus: 'PROOF_PENDING',
        submittedBy: expect.objectContaining({ id: workerIds[0] }),
        files: [expect.objectContaining({ fileId, contentType: 'image/png', sizeBytes: 2048 })],
      }),
    ]);
    expect(body.data.editHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'FIELD_EDIT', fieldName: 'description', editedByUserId: hirerId }),
      expect.objectContaining({
        kind: 'EDIT_REQUEST',
        id: editRequestId,
        apiVersion: 'v1',
        requestStatus: 'EDIT_REQUEST_APPROVED',
        responses: [expect.objectContaining({ workerId: workerIds[0], decision: 'EDIT_RESPONSE_APPROVED' })],
      }),
    ]));
    expect(body.data.adminActions).toEqual([
      expect.objectContaining({
        action: 'QUEST_REVIEW_NOTE',
        reasonCode: 'POLICY_REVIEW',
        admin: expect.objectContaining({ id: adminId }),
      }),
    ]);
  });

  it('reads team candidates for a Group Quest', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${teamQuestId}`);
    const body = await response.json() as { data: Record<string, any> };

    expect(response.status).toBe(200);
    expect(body.data.candidates.teams).toEqual([
      expect.objectContaining({
        id: teamId,
        name: 'Team Facet',
        teamStatus: 'TEAM_SELECTED',
        leaderId: workerIds[1],
        members: expect.arrayContaining([
          expect.objectContaining({ member: expect.objectContaining({ id: workerIds[1] }) }),
          expect.objectContaining({ member: expect.objectContaining({ id: workerIds[2] }) }),
        ]),
      }),
    ]);
  });

  it('reads v2 edit requests in edit history', async () => {
    const response = await adminRequest(`/api/v1/admin/quests/${v2QuestId}`);
    const body = await response.json() as { data: Record<string, any> };

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
