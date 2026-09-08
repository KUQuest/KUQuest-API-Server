import { app } from '@/app';
import { db, sql } from '@/database/client';
import { adminAction } from '@/database/schema/admin.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { quest } from '@/database/schema/quest.schema';
import type { QuestStatus } from '@/modules/quest/quest.contract';
import { tag } from '@/database/schema/tag.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';

import { randomUUID } from 'node:crypto';

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

type OverviewResponse = {
  data: {
    quests: { total: number; hidden: number; byStatus: Record<string, number> };
    disputes: { total: number; awaitingResolution: number };
    payouts: { pendingAdminApproval: number; inFlight: number };
    members: { frozenWallets: number; suspendedWallets: number };
  };
};

type ActivityResponse = {
  data: { items: Array<Record<string, unknown>>; nextCursor: string | null };
};

const adminEmail = `admin-overview-${randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
let adminCookie = '';
let adminId = '';

const memberEmail = `admin-overview-member-${randomUUID()}@ku.th`;
const memberPassword = 'TestStudent1!';
const memberAuthApp = new Elysia({ name: 'admin-overview-member-test-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: memberEmail,
    password: memberPassword,
    firstName: 'Overview',
    lastName: 'Member',
  }),
);
let memberCookie = '';

const hirerId = randomUUID();
const tagId = randomUUID();
const questIds: string[] = [];
const actionIds: string[] = [];
const requestKeys: string[] = [];

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const adminRequest = (path: string) => app.handle(new Request(`http://localhost${path}`, {
  headers: { cookie: adminCookie },
}));

const overview = async () => {
  const response = await adminRequest('/api/v1/admin/overview');
  expect(response.status).toBe(200);
  return (await response.json() as OverviewResponse).data;
};

const seedQuest = async (values: { questStatus: QuestStatus; hiddenAt?: Date }) => {
  const id = randomUUID();
  questIds.push(id);
  await db.insert(quest).values({
    id,
    hirerId,
    title: `Overview quest ${id}`,
    condition: 'Do the work',
    mode: 'NO_CANDIDATE',
    participation: 'SOLO',
    questStatus: values.questStatus,
    rewardSatang: 1_000,
    tagId,
    startTime: new Date('2030-07-01T00:00:00.000Z'),
    hiddenAt: values.hiddenAt ?? null,
    hiddenByAdminId: values.hiddenAt ? adminId : null,
  });
  return id;
};

const seedAdminAction = async (values: {
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: Date;
}) => {
  const requestKey = `overview-${randomUUID()}`;
  requestKeys.push(requestKey);
  const [row] = await db.insert(adminAction).values({
    adminId,
    action: values.action,
    resourceType: values.resourceType,
    resourceId: values.resourceId,
    requestKey,
    requestHash: 'a'.repeat(64),
    reasonCatalogVersion: 1,
    reasonCode: 'POLICY_REVIEW',
    metadata: { safe: 'value' },
    resultData: { summary: 'value' },
    createdAt: values.createdAt,
  }).returning({ id: adminAction.id });
  if (row) actionIds.push(row.id);
  return row!.id;
};

beforeAll(async () => {
  await sql`select 1`;

  await db.insert(authUser).values({
    id: hirerId,
    email: `${hirerId}@ku.th`,
    firstName: 'Overview',
    lastName: 'Hirer',
  });
  await db.insert(tag).values({ id: tagId, name: `Admin overview test ${tagId}` });

  const seedAuth = createAdminAuth({ allowSignUp: true, autoSignIn: false, markEmailVerified: true });
  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Overview Admin',
      firstName: 'Overview',
      lastName: 'Admin',
    },
  });
  const loginResponse = await app.handle(new Request('http://localhost/api/admin/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword }),
  }));
  if (loginResponse.status !== 200) throw new Error(`Admin authentication failed: ${loginResponse.status}`);
  adminCookie = getCookieHeader(loginResponse);
  const [admin] = await db.select({ id: authAdmin.id }).from(authAdmin).where(eq(authAdmin.email, adminEmail));
  adminId = admin!.id;

  const memberLogin = await memberAuthApp.handle(
    new Request('http://localhost/api/staging/test-auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: memberEmail, password: memberPassword }),
    }),
  );
  if (memberLogin.status !== 200) throw new Error(`Member authentication failed: ${memberLogin.status}`);
  memberCookie = getCookieHeader(memberLogin);
});

afterAll(async () => {
  // Admin Action rows are immutable, so only the Quests they point at are removed.
  if (questIds.length > 0) await db.delete(quest).where(inArray(quest.id, questIds));
});

describe('Admin Overview and Activity Log', () => {
  it('requires an Admin Session and rejects a Member Session', async () => {
    const anonymousOverview = await app.handle(new Request('http://localhost/api/v1/admin/overview'));
    const anonymousActivity = await app.handle(new Request('http://localhost/api/v1/admin/activity-log'));
    const memberOverview = await app.handle(new Request('http://localhost/api/v1/admin/overview', {
      headers: { cookie: memberCookie },
    }));
    const memberActivity = await app.handle(new Request('http://localhost/api/v1/admin/activity-log', {
      headers: { cookie: memberCookie },
    }));

    expect(anonymousOverview.status).toBe(401);
    expect(anonymousActivity.status).toBe(401);
    expect(memberOverview.status).toBe(401);
    expect(memberActivity.status).toBe(401);
  });

  it('publishes the Admin Overview contract in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/admin/overview']?.get?.operationId).toBe('getAdminOverview');
    expect(document.paths['/api/v1/admin/activity-log']?.get?.operationId).toBe('listAdminActivityLog');
  });

  it('counts the Quest queue by canonical status and hidden overlay', async () => {
    const before = await overview();

    await seedQuest({ questStatus: 'QUEST_OPEN' });
    await seedQuest({ questStatus: 'QUEST_OPEN', hiddenAt: new Date() });
    await seedQuest({ questStatus: 'QUEST_DISPUTED' });

    const after = await overview();

    expect(after.quests.total - before.quests.total).toBe(3);
    expect(after.quests.hidden - before.quests.hidden).toBe(1);
    expect(after.quests.byStatus.QUEST_OPEN! - before.quests.byStatus.QUEST_OPEN!).toBe(2);
    expect(after.quests.byStatus.QUEST_DISPUTED! - before.quests.byStatus.QUEST_DISPUTED!).toBe(1);
  });

  it('reports the Dispute, Payout, and Member queues as counters', async () => {
    const counters = await overview();

    expect(counters.disputes.total).toBeGreaterThanOrEqual(counters.disputes.awaitingResolution);
    expect(counters.payouts.pendingAdminApproval).toBeGreaterThanOrEqual(0);
    expect(counters.payouts.inFlight).toBeGreaterThanOrEqual(0);
    expect(counters.members.frozenWallets).toBeGreaterThanOrEqual(0);
    expect(counters.members.suspendedWallets).toBeGreaterThanOrEqual(0);
    expect(counters).not.toHaveProperty('reports');
  });

  it('pages the Activity Log by cursor and filters it by action and resource', async () => {
    const questId = await seedQuest({ questStatus: 'QUEST_OPEN' });
    const older = await seedAdminAction({
      action: 'QUEST_HIDE',
      resourceType: 'quest',
      resourceId: questId,
      createdAt: new Date('2030-07-01T00:00:00.000Z'),
    });
    const newer = await seedAdminAction({
      action: 'QUEST_RESTORE',
      resourceType: 'quest',
      resourceId: questId,
      createdAt: new Date('2030-07-02T00:00:00.000Z'),
    });

    const scoped = await adminRequest(`/api/v1/admin/activity-log?resourceId=${questId}&limit=50`);
    const scopedBody = await scoped.json() as ActivityResponse;
    expect(scoped.status).toBe(200);
    expect(scopedBody.data.items.map((item) => item.id)).toEqual([newer, older]);

    const filtered = await adminRequest(`/api/v1/admin/activity-log?resourceId=${questId}&action=QUEST_HIDE&limit=50`);
    const filteredBody = await filtered.json() as ActivityResponse;
    expect(filtered.status).toBe(200);
    expect(filteredBody.data.items.map((item) => item.id)).toEqual([older]);

    const firstPage = await adminRequest(`/api/v1/admin/activity-log?resourceId=${questId}&limit=1`);
    const firstPageBody = await firstPage.json() as ActivityResponse;
    expect(firstPageBody.data.items.map((item) => item.id)).toEqual([newer]);
    expect(firstPageBody.data.nextCursor).toBeString();

    const secondPage = await adminRequest(
      `/api/v1/admin/activity-log?resourceId=${questId}&limit=1&cursor=${encodeURIComponent(firstPageBody.data.nextCursor!)}`,
    );
    const secondPageBody = await secondPage.json() as ActivityResponse;
    expect(secondPageBody.data.items.map((item) => item.id)).toEqual([older]);

    const oldestFirst = await adminRequest(`/api/v1/admin/activity-log?resourceId=${questId}&sort=oldest&limit=50`);
    const oldestFirstBody = await oldestFirst.json() as ActivityResponse;
    expect(oldestFirstBody.data.items.map((item) => item.id)).toEqual([older, newer]);

    const invalidCursor = await adminRequest('/api/v1/admin/activity-log?cursor=not-valid-base64url!!');
    expect(invalidCursor.status).toBe(400);
  });

  it('keeps Admin Action metadata, request keys, and hashes out of the Activity Log', async () => {
    const questId = await seedQuest({ questStatus: 'QUEST_OPEN' });
    await seedAdminAction({
      action: 'QUEST_HIDE',
      resourceType: 'quest',
      resourceId: questId,
      createdAt: new Date('2030-07-03T00:00:00.000Z'),
    });

    const response = await adminRequest(`/api/v1/admin/activity-log?resourceId=${questId}&limit=50`);
    const body = await response.json() as ActivityResponse;
    const entry = body.data.items[0]!;

    expect(Object.keys(entry).sort()).toEqual([
      'action',
      'admin',
      'createdAt',
      'id',
      'reasonCatalogVersion',
      'reasonCode',
      'resourceId',
      'resourceType',
      'resultTimestamp',
      'resultVersion',
    ]);
    expect(entry.admin).toEqual({ id: adminId, firstName: 'Overview', lastName: 'Admin' });
  });
});
