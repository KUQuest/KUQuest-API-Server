import { app } from '@/app';
import { db, sql } from '@/database/client';
import { authAdmin } from '@/database/schema/auth.schema';
import { createStagingTestAuthRoute } from '@/modules/auth';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { encodeCursor } from '@/shared/cursor';

import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

type ActivityEntry = {
  id: string;
  admin: { id: string; firstName: string; lastName: string };
  action: string;
  resourceType: string;
  resourceId: string;
  reasonCode: string | null;
  reasonCatalogVersion: number;
  resultVersion: number | null;
  resultTimestamp: string | null;
  createdAt: string;
};

type ActivityResponse = {
  success: boolean;
  data?: { items: ActivityEntry[]; nextCursor: string | null };
  error?: { code: string; message: string };
};

const adminEmail = `admin-activity-log-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminPass1!';
const memberEmail = `admin-activity-log-member-${crypto.randomUUID()}@ku.th`;
const memberPassword = 'MemberPass1!';
const secondAdminId = crypto.randomUUID();

const memberAuthApp = new Elysia({ name: 'admin-activity-log-member-auth' }).use(
  createStagingTestAuthRoute({
    enabled: true,
    deploymentEnv: 'staging',
    email: memberEmail,
    password: memberPassword,
    firstName: 'Activity',
    lastName: 'Member',
  }),
);

let adminId = '';
let adminCookie = '';
let memberCookie = '';

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

const activityRequest = (query = '', cookie = adminCookie) => app.handle(new Request(
  `http://localhost/api/v1/admin/activity-log${query ? `?${query}` : ''}`,
  cookie ? { headers: { cookie } } : undefined,
));

const query = (values: Record<string, string | number>): string =>
  new URLSearchParams(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  ).toString();

const readActivity = async (values: Record<string, string | number> = {}) => {
  const response = await activityRequest(query(values));
  expect(response.status).toBe(200);
  const body = await response.json() as ActivityResponse;
  expect(body.success).toBe(true);
  return body.data!;
};

const seedAdminAction = async (values: {
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  createdAt: string;
  reasonCode?: string | null;
  reasonCatalogVersion?: number;
  resultVersion?: number | null;
  resultTimestamp?: string | null;
  metadata?: Record<string, unknown>;
  resultData?: Record<string, unknown>;
}): Promise<string> => {
  const requestKey = `activity-log-${crypto.randomUUID()}`;
  const [row] = await sql`
    insert into admin_action
      (admin_id, action, resource_type, resource_id, request_key, request_hash,
       reason_catalog_version, reason_code, result_version, result_timestamp,
       metadata, result_data, created_at)
    values
      (${values.actorId ?? adminId}, ${values.action}, ${values.resourceType}, ${values.resourceId},
       ${requestKey}, ${'a'.repeat(64)}, ${values.reasonCatalogVersion ?? 1},
       ${values.reasonCode === undefined ? 'ACTIVITY_REVIEW' : values.reasonCode},
       ${values.resultVersion === undefined ? 1 : values.resultVersion},
       ${values.resultTimestamp === undefined ? null : values.resultTimestamp},
       ${JSON.stringify(values.metadata ?? { safe: 'value' })}::jsonb,
       ${JSON.stringify(values.resultData ?? { summary: 'value' })}::jsonb,
       ${values.createdAt}::timestamptz)
    returning id
  `;
  if (!row) throw new Error('Admin Action fixture was not created.');
  return (row as { id: string }).id;
};

beforeAll(async () => {
  await sql`select 1`;

  await db.insert(authAdmin).values({
    id: secondAdminId,
    email: `${secondAdminId}@example.com`,
    firstName: 'Second',
    lastName: 'Admin',
  });

  const seedAuth = createAdminAuth({ allowSignUp: true, autoSignIn: false, markEmailVerified: true });
  await seedAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Activity Admin',
      firstName: 'Activity',
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
  if (!admin) throw new Error('Activity Log Admin fixture was not created.');
  adminId = admin.id;

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
  if (adminId) {
    await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
  }
});

describe('Admin Activity Log API', () => {
  it('allows enabled Admins to read every Admin Action and preserves auth responses', async () => {
    const resourceId = `activity-auth-${crypto.randomUUID()}`;
    await seedAdminAction({
      actorId: secondAdminId,
      action: 'ACTIVITY_AUTH_CHECK',
      resourceType: 'activity',
      resourceId,
      createdAt: '2030-08-01T00:00:00.000Z',
    });

    const anonymous = await activityRequest('', '');
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });

    const member = await activityRequest('', memberCookie);
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Forbidden' },
    });

    const enabledAdmin = await activityRequest(query({ resourceId }));
    expect(enabledAdmin.status).toBe(200);
    const enabledBody = await enabledAdmin.json() as ActivityResponse;
    expect(enabledBody.data?.items[0]?.admin.id).toBe(secondAdminId);

    await db.update(authAdmin).set({ disabledAt: new Date() }).where(eq(authAdmin.id, adminId));
    try {
      const disabledAdmin = await activityRequest(query({ resourceId }));
      expect(disabledAdmin.status).toBe(403);
      expect(await disabledAdmin.json()).toEqual({
        success: false,
        error: { code: 'ADMIN_DISABLED', message: 'Admin account is disabled' },
      });
    } finally {
      await db.update(authAdmin).set({ disabledAt: null }).where(eq(authAdmin.id, adminId));
    }
  });

  it('publishes the versioned Activity Log route and response errors in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, unknown> }>>;
    };
    const operation = document.paths['/api/v1/admin/activity-log']?.get;

    expect(response.status).toBe(200);
    expect(operation?.operationId).toBe('listAdminActivityLog');
    expect(operation?.responses).toHaveProperty('400');
    expect(operation?.responses).toHaveProperty('401');
    expect(operation?.responses).toHaveProperty('403');
  });

  it('supports action, resource type, resource ID, and Admin ID filters with a safe projection', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const action = `ACTIVITY_FILTER_${suffix}`;
    const otherAction = `ACTIVITY_OTHER_${suffix}`;
    const resourceType = `activity-type-${suffix}`;
    const otherResourceType = `other-type-${suffix}`;
    const resourceId = `activity-resource-${suffix}`;
    const otherResourceId = `other-resource-${suffix}`;

    const main = await seedAdminAction({
      actorId: secondAdminId,
      action,
      resourceType,
      resourceId,
      createdAt: '2030-08-02T00:00:00.000Z',
      reasonCatalogVersion: 7,
      resultVersion: 4,
      resultTimestamp: null,
      metadata: {
        safe: 'visible only in storage',
        messageText: 'private Message text',
        signedUrl: 'https://private.example/signed-token',
        credentials: 'secret credentials',
      },
      resultData: { evidence: 'private evidence', token: 'secret-token' },
    });
    const actionMatch = await seedAdminAction({
      action,
      resourceType: otherResourceType,
      resourceId: otherResourceId,
      createdAt: '2030-08-04T00:00:00.000Z',
    });
    const typeMatch = await seedAdminAction({
      action: otherAction,
      resourceType,
      resourceId: otherResourceId,
      createdAt: '2030-08-03T00:00:00.000Z',
    });
    const resourceMatch = await seedAdminAction({
      action: otherAction,
      resourceType: otherResourceType,
      resourceId,
      createdAt: '2030-08-01T00:00:00.000Z',
    });

    expect((await readActivity({ action })).items.map((item) => item.id)).toEqual([actionMatch, main]);
    expect((await readActivity({ resourceType })).items.map((item) => item.id)).toEqual([typeMatch, main]);
    expect((await readActivity({ resourceId })).items.map((item) => item.id)).toEqual([main, resourceMatch]);
    expect((await readActivity({ adminId: secondAdminId })).items.map((item) => item.id)).toContain(main);

    const entry = (await readActivity({ resourceId })).items[0]!;
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
    expect(entry).toMatchObject({
      id: main,
      action,
      resourceType,
      resourceId,
      reasonCode: 'ACTIVITY_REVIEW',
      reasonCatalogVersion: 7,
      resultVersion: 4,
      resultTimestamp: null,
      admin: { id: secondAdminId, firstName: 'Second', lastName: 'Admin' },
    });
    expect(JSON.stringify(entry)).not.toContain('private Message text');
    expect(JSON.stringify(entry)).not.toContain('signed-token');
    expect(JSON.stringify(entry)).not.toContain('secret-token');
  });

  it('traverses newest-first and oldest-first without skipping or repeating microsecond and tie-ordered rows', async () => {
    const resourceId = `activity-page-${crypto.randomUUID()}`;
    const first = await seedAdminAction({
      action: 'ACTIVITY_PAGE',
      resourceType: 'activity',
      resourceId,
      createdAt: '2030-08-05T00:00:00.100200Z',
    });
    const tieFirst = await seedAdminAction({
      action: 'ACTIVITY_PAGE',
      resourceType: 'activity',
      resourceId,
      createdAt: '2030-08-05T00:00:00.101300Z',
    });
    const tieSecond = await seedAdminAction({
      action: 'ACTIVITY_PAGE',
      resourceType: 'activity',
      resourceId,
      createdAt: '2030-08-05T00:00:00.101300Z',
    });
    const last = await seedAdminAction({
      action: 'ACTIVITY_PAGE',
      resourceType: 'activity',
      resourceId,
      createdAt: '2030-08-05T00:00:00.102400Z',
    });
    const tieAscending = [tieFirst, tieSecond].sort((left, right) => left < right ? -1 : 1);

    const readEveryPage = async (sort: 'newest' | 'oldest'): Promise<string[]> => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 8; page += 1) {
        const values: Record<string, string | number> = { resourceId, sort, limit: 1 };
        if (cursor) values.cursor = cursor;
        // Each page cursor comes from the previous response, so these requests
        // must remain sequential.
        // eslint-disable-next-line no-await-in-loop
        const response = await activityRequest(query(values));
        expect(response.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const body = await response.json() as ActivityResponse;
        expect(body.success).toBe(true);
        ids.push(...body.data!.items.map((item) => item.id));
        cursor = body.data!.nextCursor;
        if (!cursor) break;
      }
      expect(cursor).toBeNull();
      return ids;
    };

    expect(await readEveryPage('oldest')).toEqual([first, ...tieAscending, last]);
    expect(await readEveryPage('newest')).toEqual([last, ...tieAscending.reverse(), first]);
  });

  it('rejects invalid cursors and invalid query values with the shared error envelope', async () => {
    const expectBadRequest = async (response: Response, code: string) => {
      expect(response.status).toBe(400);
      const body = await response.json() as ActivityResponse;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe(code);
      expect(body.error?.message).toBeString();
    };

    await expectBadRequest(
      await activityRequest(query({ cursor: 'not-valid-base64url!!' })),
      'INVALID_CURSOR',
    );
    await expectBadRequest(
      await activityRequest(query({
        cursor: encodeCursor({
          id: crypto.randomUUID(),
          startTime: '2030-08-10T00:00:00.000Z',
        }),
      })),
      'INVALID_CURSOR',
    );
    await expectBadRequest(await activityRequest(query({ limit: 51 })), 'VALIDATION');
    await expectBadRequest(await activityRequest(query({ sort: 'sideways' })), 'VALIDATION');
    await expectBadRequest(await activityRequest(query({ adminId: 'not-a-uuid' })), 'VALIDATION');
  });
});
