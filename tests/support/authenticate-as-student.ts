import { auth } from '@/modules/auth/auth.config';
import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';

import { randomUUID } from 'node:crypto';

import { makeSignature } from 'better-auth/crypto';
import { inArray } from 'drizzle-orm';

// QA-33's fixture: obtain a working Session for a Student a test creates, without
// contacting Google. Mints the Session the same way `scripts/seed-demo-users.ts`
// does — through Better Auth's own internal adapter — rather than driving a real
// OAuth exchange or an HTTP sign-up round trip, so it stays fast and dependency-free.
// See CODESTYLES.md's Testing section and `docs/adr/0002-profile-ownership-proven-below-http.md`
// for when to reach for this instead of a lower seam.

export type StudentSessionFixture = {
  userId: string;
  /** Ready to send verbatim as the request's `Cookie` header. */
  cookie: string;
};

type CreateStudentOptions = {
  email?: string;
  firstName?: string;
  lastName?: string;
};

export const authenticateAsStudent = async (
  options: CreateStudentOptions = {},
): Promise<StudentSessionFixture> => {
  const email = options.email ?? `test-student-${randomUUID()}@ku.th`;

  const [user] = await db
    .insert(authUser)
    .values({
      email,
      emailVerified: true,
      firstName: options.firstName ?? 'Test',
      lastName: options.lastName ?? 'Student',
    })
    .returning({ id: authUser.id });

  if (!user) throw new Error(`Failed to create test Student ${email}`);

  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(user.id, false, {
    ipAddress: '127.0.0.1',
    userAgent: 'authenticate-as-student test fixture',
  });
  const signedToken = `${session.token}.${await makeSignature(session.token, ctx.secret)}`;
  const cookie = `${ctx.authCookies.sessionToken.name}=${signedToken}`;

  return { userId: user.id, cookie };
};

// Deletes every Student `authenticateAsStudent` created, so a repeated run starts
// clean. `auth_session`/`auth_account` both cascade-delete off `auth_user`
// (auth.schema.ts), so nothing else needs deleting separately.
export const cleanupStudentSessions = async (userIds: string[]): Promise<void> => {
  if (userIds.length === 0) return;
  await db.delete(authUser).where(inArray(authUser.id, userIds));
};
