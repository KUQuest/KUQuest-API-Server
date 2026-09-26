import { app } from '@/app';
import { db, sql } from '@/database/client';
import { department, faculty, occupation } from '@/database/schema/academic.schema';
import { authAdmin, authUser } from '@/database/schema/auth.schema';
import { createAdminAuth } from '@/modules/auth/admin-auth.config';
import { ensureInitialMoneyPolicy, ensureWallet } from '@/modules/wallet';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

const adminEmail = `admin-member-test-${crypto.randomUUID()}@example.com`;
const adminPassword = 'AdminMemberPass1!';

let adminId = '';
let adminCookie = '';

const facultyId = crypto.randomUUID();
const departmentId = crypto.randomUUID();
const occupationId = crypto.randomUUID();

const memberId = crypto.randomUUID();
const memberStudentId = String(Math.floor(1000000000 + Math.random() * 9000000000));

const getCookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

type IdRow = { id: string };

type MemberListPage = {
  data?: { items: { id: string }[]; nextCursor: string | null };
};

type MemberErrorBody = {
  success: boolean;
  error?: { code: string; message: string };
};

beforeAll(async () => {
  await sql`select 1`;
  await ensureInitialMoneyPolicy();

  // Create faculty, department, occupation
  await db.insert(faculty).values({
    id: facultyId,
    name: `Engineering ${facultyId.slice(0, 6)}`,
  });

  await db.insert(department).values({
    id: departmentId,
    facultyId,
    name: `Computer Engineering ${departmentId.slice(0, 6)}`,
  });

  await db.insert(occupation).values({
    id: occupationId,
    name: `Student ${occupationId.slice(0, 6)}`,
    requiresStudentId: true,
  });

  // Create member
  await db.insert(authUser).values({
    id: memberId,
    email: `${memberId}@ku.th`,
    firstName: 'MemberDir',
    lastName: 'Tester',
    studentId: memberStudentId,
    telephone: '0899999999',
    bio: 'Software Engineering student',
    academicYear: 2567,
    departmentId,
    occupationId,
  });

  await ensureWallet(memberId);

  // Create Admin
  const adminAuth = createAdminAuth({
    allowSignUp: true,
    autoSignIn: false,
    markEmailVerified: true,
  });
  const signUp = await adminAuth.api.signUpEmail({
    body: {
      email: adminEmail,
      password: adminPassword,
      name: 'Member Admin',
      firstName: 'Member',
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
  if (adminLogin.status !== 200) throw new Error('Admin login failed');
  adminCookie = getCookieHeader(adminLogin);
});

afterAll(async () => {
  if (adminId) {
    await db.delete(authAdmin).where(eq(authAdmin.id, adminId));
  }
  await db
    .update(authUser)
    .set({ departmentId: null, occupationId: null })
    .where(eq(authUser.id, memberId));
  await db.delete(department).where(eq(department.id, departmentId));
  await db.delete(faculty).where(eq(faculty.id, facultyId));
  await db.delete(occupation).where(eq(occupation.id, occupationId));
});

describe('Admin Members Endpoints Integration Tests', () => {
  describe('GET /api/v1/admin/members', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const res = await app.handle(new Request('http://localhost/api/v1/admin/members'));
      expect(res.status).toBe(401);
    });

    it('lists members with academic profile and wallet summary', async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/members?search=${memberStudentId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.items.length).toBe(1);

      const m = json.data.items[0];
      expect(m.id).toBe(memberId);
      expect(m.firstName).toBe('MemberDir');
      expect(m.studentId).toBe(memberStudentId);
      expect(m.department).toContain('Computer Engineering');
      expect(m.faculty).toContain('Engineering');
      expect(m.occupation).toContain('Student');
      expect(m.wallet).not.toBeNull();
      expect(m.wallet.walletStatus).toBe('ACTIVE');
    });

    const memberListRequest = (params: URLSearchParams) =>
      app.handle(
        new Request(`http://localhost/api/v1/admin/members?${params}`, {
          headers: { cookie: adminCookie },
        })
      );

    const expectInvalidCursor = async (response: Response, message: string) => {
      expect(response.status).toBe(400);
      const body = (await response.json()) as MemberErrorBody;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('INVALID_CURSOR');
      expect(body.error?.message).toBe(message);
    };

    const seedCursorMember = async (marker: string, createdAt: string): Promise<string> => {
      // Raw SQL seeding keeps microsecond precision; a JavaScript Date and the
      // query builder truncate timestamps to milliseconds.
      const id = crypto.randomUUID();
      const [row] = (await sql`
        insert into auth_user (id, email, first_name, last_name, created_at)
        values (${id}, ${`${id}@ku.th`}, 'Cursor', ${marker}, ${createdAt}::timestamptz)
        returning id
      `) as IdRow[];
      if (!row) throw new Error('Member fixture was not created.');
      return row.id;
    };

    it('pages every member exactly once across a shared millisecond at limit 1', async () => {
      const marker = `member-cursor-${crypto.randomUUID()}`;
      const createdAtValues = [
        '2030-08-05T00:00:00.100200Z',
        '2030-08-05T00:00:00.100800Z',
        '2030-08-05T00:00:00.101300Z',
        '2030-08-05T00:00:00.205700Z',
      ];
      const seededIds: string[] = [];
      try {
        for (const createdAt of createdAtValues) {
          // eslint-disable-next-line no-await-in-loop
          seededIds.push(await seedCursorMember(marker, createdAt));
        }

        const ids: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 8; page += 1) {
          const params = new URLSearchParams({ search: marker, limit: '1' });
          if (cursor) params.set('cursor', cursor);
          // Each page cursor comes from the previous response, so these
          // requests must remain sequential.
          // eslint-disable-next-line no-await-in-loop
          const response = await memberListRequest(params);
          expect(response.status).toBe(200);
          // eslint-disable-next-line no-await-in-loop
          const body = (await response.json()) as MemberListPage;
          expect(body.data).toBeDefined();
          ids.push(...body.data!.items.map((item) => item.id));
          cursor = body.data!.nextCursor;
          if (!cursor) break;
        }
        expect(cursor).toBeNull();
        expect(ids).toEqual([...seededIds].reverse());
      } finally {
        await db.delete(authUser).where(eq(authUser.lastName, marker));
      }
    });

    it('rejects a deleted cursor anchor and a malformed cursor with the shared error envelope', async () => {
      const marker = `member-cursor-${crypto.randomUUID()}`;
      const newestId = await seedCursorMember(marker, '2030-08-05T00:00:00.200900Z');
      await seedCursorMember(marker, '2030-08-05T00:00:00.100200Z');
      try {
        const page = await memberListRequest(new URLSearchParams({ search: marker, limit: '1' }));
        expect(page.status).toBe(200);
        const pageBody = (await page.json()) as MemberListPage;
        expect(pageBody.data?.nextCursor).toBeString();

        await db.delete(authUser).where(eq(authUser.id, newestId));
        await expectInvalidCursor(
          await memberListRequest(
            new URLSearchParams({
              search: marker,
              limit: '1',
              cursor: pageBody.data!.nextCursor!,
            })
          ),
          'cursor does not match a Member'
        );
        await expectInvalidCursor(
          await memberListRequest(
            new URLSearchParams({ search: marker, cursor: 'not-valid-base64url!!' })
          ),
          'cursor is invalid'
        );
      } finally {
        await db.delete(authUser).where(eq(authUser.lastName, marker));
      }
    });

    it('accepts the shared maximum page limit and rejects one above it', async () => {
      const atMaximum = await memberListRequest(new URLSearchParams({ limit: '50' }));
      expect(atMaximum.status).toBe(200);

      const aboveMaximum = await memberListRequest(new URLSearchParams({ limit: '51' }));
      expect(aboveMaximum.status).toBe(400);
      const body = (await aboveMaximum.json()) as MemberErrorBody;
      expect(body.success).toBe(false);
      expect(body.error?.code).toBe('VALIDATION');
    });
  });

  describe('GET /api/v1/admin/members/:id', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/members/${memberId}`)
      );
      expect(res.status).toBe(401);
    });

    it('returns 404 when member does not exist', async () => {
      const nonExistentId = crypto.randomUUID();
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/members/${nonExistentId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error.code).toBe('MEMBER_NOT_FOUND');
    });

    it('returns complete member details, wallet, and marketplace performance stats', async () => {
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/members/${memberId}`, {
          headers: { cookie: adminCookie },
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      const data = json.data;
      expect(data.member.id).toBe(memberId);
      expect(data.member.studentId).toBe(memberStudentId);
      expect(data.member.bio).toBe('Software Engineering student');
      expect(data.member.academicYear).toBe(2567);
      expect(data.member.department).toContain('Computer Engineering');
      expect(data.member.faculty).toContain('Engineering');
      expect(data.member.occupation).toContain('Student');

      expect(data.wallet).not.toBeNull();
      expect(data.wallet.walletStatus).toBe('ACTIVE');
      expect(data.wallet.projectionMatchesLedger).toBe(true);

      expect(data.stats).toBeDefined();
      expect(typeof data.stats.questsCreatedCount).toBe('number');
      expect(typeof data.stats.questsCompletedAsWorkerCount).toBe('number');
      expect(typeof data.stats.reviewsReceivedCount).toBe('number');
      expect(typeof data.stats.payoutsCount).toBe('number');
      expect(typeof data.stats.totalEarnedSatang).toBe('number');
      expect(typeof data.stats.totalPaidOutSatang).toBe('number');
    });
  });
});
