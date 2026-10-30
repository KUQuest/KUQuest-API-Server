import { db } from '@/database/client';
import { authAdmin } from '@/database/schema/auth.schema';
import { recordMemberConfirmedViolationInTransaction } from '@/modules/admin/member-penalty';
import { createStudentAuth } from '@/modules/auth';
import { profileRoute } from '@/modules/profile/profile.route';

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

const studentAuth = createStudentAuth({
  emailAndPasswordEnabled: true,
  allowEmailSignUp: true,
  autoSignIn: false,
  provisionWalletOnCreate: false,
});

const authRequest = (path: string, body: unknown) =>
  studentAuth.handler(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const createMember = async () => {
  const email = `penalty-status-${randomUUID()}@ku.th`;
  const password = 'MemberPass1!';
  const signUp = await authRequest('/api/auth/sign-up/email', {
    email,
    password,
    name: 'Penalty Status',
    firstName: 'Penalty',
    lastName: 'Status',
  });
  const memberId = (await signUp.json()).user.id as string;
  const signIn = () => authRequest('/api/auth/sign-in/email', { email, password });
  const cookie = ((await signIn()).headers.getSetCookie?.() ?? [])
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  return { memberId, cookie, signIn };
};

const createAdmin = async (): Promise<string> => {
  const adminId = randomUUID();
  await db.insert(authAdmin).values({
    id: adminId,
    email: `${adminId}@example.com`,
    firstName: 'Penalty',
    lastName: 'Admin',
  });
  return adminId;
};

const recordViolation = (
  memberId: string,
  actorAdminId: string,
  source: 'REPORT_CASE' | 'CONDUCT_REPORT'
) =>
  db.transaction((transaction) =>
    recordMemberConfirmedViolationInTransaction(transaction, {
      memberId,
      source,
      sourceId: randomUUID(),
      actorAdminId,
      reasonCode: 'SAFETY_REVIEW',
      now: new Date(),
    })
  );

const readStatus = (cookie: string) =>
  profileRoute.handle(
    new Request('http://localhost/api/v1/profile/penalty-status', { headers: { cookie } })
  );

describe('own Member Penalty status', () => {
  it('requires authentication', async () => {
    const response = await readStatus('');

    expect(response.status).toBe(401);
  });

  it('reports a clean Member with the first result of each ladder', async () => {
    const { cookie } = await createMember();

    const response = await readStatus(cookie);

    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({
      misconduct: { strikeCount: 0, ladderLength: 3, nextResult: 'PENALTY_RED_FLAG' },
      review: { strikeCount: 0, ladderLength: 3, nextResult: 'PENALTY_TEMPORARY_BAN_7_DAYS' },
      redFlagExpiresAt: null,
    });
  });

  it('counts a Red Flag strike, ignores an exempt violation, and returns the expiry', async () => {
    const { memberId, cookie } = await createMember();
    const adminId = await createAdmin();

    await recordViolation(memberId, adminId, 'CONDUCT_REPORT');
    await recordViolation(memberId, adminId, 'REPORT_CASE');

    const { data } = await (await readStatus(cookie)).json();
    expect(data.misconduct).toEqual({
      strikeCount: 1,
      ladderLength: 3,
      nextResult: 'PENALTY_TEMPORARY_BAN_7_DAYS',
    });
    expect(data.review.strikeCount).toBe(0);
    expect(new Date(data.redFlagExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns the ban details on an existing session and on sign-in', async () => {
    const { memberId, cookie, signIn } = await createMember();
    const adminId = await createAdmin();

    await recordViolation(memberId, adminId, 'CONDUCT_REPORT');
    await recordViolation(memberId, adminId, 'CONDUCT_REPORT');

    const temporary = await readStatus(cookie);
    const temporaryBody = await temporary.json();
    expect(temporary.status).toBe(403);
    expect(temporaryBody.error.code).toBe('MEMBER_BANNED');
    expect(temporaryBody.error.memberBan.permanent).toBe(false);
    expect(new Date(temporaryBody.error.memberBan.bannedUntil).getTime()).toBeGreaterThan(
      Date.now()
    );

    const temporarySignIn = await signIn();
    const temporarySignInBody = await temporarySignIn.json();
    expect(temporarySignIn.status).toBe(403);
    expect(temporarySignInBody.code).toBe('MEMBER_BANNED');
    expect(temporarySignInBody.memberBan.bannedUntil).toBe(
      temporaryBody.error.memberBan.bannedUntil
    );

    await recordViolation(memberId, adminId, 'CONDUCT_REPORT');

    const permanent = await (await readStatus(cookie)).json();
    expect(permanent.error.memberBan.permanent).toBe(true);
  });
});
