import { env } from '@/config/env';
import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { ensureWallet } from '@/modules/wallet';

import { Elysia } from 'elysia';
import { eq } from 'drizzle-orm';

import { isValidAdminPassword } from './admin-auth.policy';
import { createStudentAuth } from './auth.config';

const stagingTestAuthBasePath = '/api/staging/test-auth';
const stagingTestAuthSignInPath = `${stagingTestAuthBasePath}/sign-in/email`;
const stagingTestAuthDefaultSignInPath = `${stagingTestAuthBasePath}/sign-in/default`;
const stagingTestAuthPaths = new Set([
  stagingTestAuthSignInPath,
  stagingTestAuthDefaultSignInPath,
  `${stagingTestAuthBasePath}/get-session`,
  `${stagingTestAuthBasePath}/sign-out`,
]);

type StagingTestAuthOptions = {
  enabled?: boolean;
  deploymentEnv?: string;
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
};

type SignInBody = {
  email?: unknown;
  password?: unknown;
};

const invalidCredentialsResponse = (): Response =>
  new Response(
    JSON.stringify({
      code: 'INVALID_EMAIL_OR_PASSWORD',
      message: 'Invalid email or password',
    }),
    {
      status: 401,
      headers: { 'content-type': 'application/json' },
    },
  );

const readSignInBody = async (request: Request): Promise<SignInBody | null> => {
  try {
    const body: unknown = await request.clone().json();

    return typeof body === 'object' && body !== null ? (body as SignInBody) : null;
  } catch {
    return null;
  }
};

const defaultSignInRequest = (request: Request, email: string, password: string): Request => {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');

  return new Request(new URL(stagingTestAuthSignInPath, request.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  });
};

export const createStagingTestAuthRoute = (
  options: StagingTestAuthOptions = {},
) => {
  const settings = {
    enabled: options.enabled ?? env.stagingTestAuthEnabled,
    deploymentEnv: options.deploymentEnv ?? env.deploymentEnv,
    email:
      options.email?.trim().toLowerCase() ?? env.stagingTestAuthEmail?.trim().toLowerCase(),
    password: options.password ?? env.stagingTestAuthPassword,
    firstName: options.firstName ?? env.stagingTestAuthFirstName,
    lastName: options.lastName ?? env.stagingTestAuthLastName,
  };
  const enabled = settings.enabled && settings.deploymentEnv === 'staging';

  if (
    enabled &&
    (!settings.email ||
      !/^[^\s@]+@ku\.th$/.test(settings.email) ||
      !settings.password ||
      !isValidAdminPassword(settings.password) ||
      !settings.firstName ||
      !settings.lastName)
  ) {
    throw new Error(
      'Staging test auth requires a valid @ku.th email, a compliant password, and a first and last name',
    );
  }

  const testAuth = createStudentAuth({
    basePath: stagingTestAuthBasePath,
    emailAndPasswordEnabled: true,
    allowEmailSignUp: true,
    autoSignIn: false,
  });

  let ensureTestStudentPromise: Promise<void> | undefined;

  const ensureTestStudent = async (): Promise<void> => {
    if (ensureTestStudentPromise) return ensureTestStudentPromise;

    ensureTestStudentPromise = (async () => {
      const existingStudent = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, settings.email!))
        .limit(1);

      let studentId = existingStudent[0]?.id;
      if (!studentId) {
        const result = await testAuth.api.signUpEmail({
          body: {
            email: settings.email!,
            password: settings.password!,
            name: `${settings.firstName} ${settings.lastName}`,
            firstName: settings.firstName!,
            lastName: settings.lastName!,
          },
        });

        if (!result.user) throw new Error('Staging test Student could not be created');
        studentId = result.user.id;
      }

      await ensureWallet(studentId);
    })();

    try {
      await ensureTestStudentPromise;
    } finally {
      ensureTestStudentPromise = undefined;
    }
  };

  const authHandler = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;

    if (!enabled || !stagingTestAuthPaths.has(pathname)) {
      return new Response(null, { status: 404 });
    }

    if (pathname === stagingTestAuthDefaultSignInPath) {
      if (request.method !== 'POST') return new Response(null, { status: 404 });

      await ensureTestStudent();
      return testAuth.handler(defaultSignInRequest(request, settings.email!, settings.password!));
    }

    if (pathname === stagingTestAuthSignInPath) {
      const body = await readSignInBody(request);
      const matchesConfiguredCredentials =
        body?.email === settings.email && body?.password === settings.password;

      if (!matchesConfiguredCredentials) return invalidCredentialsResponse();

      await ensureTestStudent();
    }

    return testAuth.handler(request);
  };

  return new Elysia({ name: 'staging-test-auth-route' }).mount(authHandler);
};

export const stagingTestAuthRoute = createStagingTestAuthRoute();
