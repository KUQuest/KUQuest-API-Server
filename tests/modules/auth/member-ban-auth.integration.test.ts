import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { authGuard, createStudentAuth, memberBanGuard } from '@/modules/auth';

import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';

const studentAuth = createStudentAuth({
  emailAndPasswordEnabled: true,
  allowEmailSignUp: true,
  autoSignIn: false,
  provisionWalletOnCreate: false,
});
const protectedApp = new Elysia({ name: 'member-ban-auth-test' })
  .use(authGuard)
  .use(memberBanGuard)
  .get('/member-only', ({ session }) => ({ memberId: session.user.id }));

let memberId: string | undefined;

const authRequest = (path: string, body: unknown) =>
  studentAuth.handler(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

const cookieHeader = (response: Response): string =>
  (response.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(';', 1)[0]).join('; ');

afterAll(async () => {
  if (memberId) await db.delete(authUser).where(eq(authUser.id, memberId));
});

describe('Member Ban authentication', () => {
  it('allows a Red Flag, then blocks existing sessions and sign-in during a ban', async () => {
    const email = `member-ban-${randomUUID()}@ku.th`;
    const password = 'MemberPass1!';
    const signUp = await authRequest('/api/auth/sign-up/email', {
      email,
      password,
      name: 'Banned Member',
      firstName: 'Banned',
      lastName: 'Member',
    });
    const signUpBody = await signUp.json();
    expect(signUp.status).toBe(200);
    const createdMemberId = signUpBody.user.id as string;
    memberId = createdMemberId;

    const signIn = await authRequest('/api/auth/sign-in/email', { email, password });
    expect(signIn.status).toBe(200);
    const cookie = cookieHeader(signIn);
    expect(cookie).not.toBe('');

    await db
      .update(authUser)
      .set({ redFlagExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
      .where(eq(authUser.id, createdMemberId));
    const redFlaggedResponse = await protectedApp.handle(
      new Request('http://localhost/member-only', { headers: { cookie } })
    );
    expect(redFlaggedResponse.status).toBe(200);

    await db
      .update(authUser)
      .set({ bannedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
      .where(eq(authUser.id, createdMemberId));
    const existingSessionResponse = await protectedApp.handle(
      new Request('http://localhost/member-only', { headers: { cookie } })
    );
    expect(existingSessionResponse.status).toBe(403);
    expect((await existingSessionResponse.json()).error.code).toBe('MEMBER_BANNED');

    const bannedSignIn = await authRequest('/api/auth/sign-in/email', { email, password });
    expect(bannedSignIn.status).toBe(403);
  });
});
