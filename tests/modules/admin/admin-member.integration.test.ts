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
  (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');

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
    }),
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
        }),
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
  });

  describe('GET /api/v1/admin/members/:id', () => {
    it('rejects unauthenticated caller with 401', async () => {
      const res = await app.handle(new Request(`http://localhost/api/v1/admin/members/${memberId}`));
      expect(res.status).toBe(401);
    });

    it('returns 404 when member does not exist', async () => {
      const nonExistentId = crypto.randomUUID();
      const res = await app.handle(
        new Request(`http://localhost/api/v1/admin/members/${nonExistentId}`, {
          headers: { cookie: adminCookie },
        }),
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
        }),
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
