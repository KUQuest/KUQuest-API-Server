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
const stagingTestAuthAccount1SignInPath = `${stagingTestAuthBasePath}/sign-in/account-1`;
const stagingTestAuthAccount2SignInPath = `${stagingTestAuthBasePath}/sign-in/account-2`;
const stagingTestAuthPaths = new Set([
  stagingTestAuthSignInPath,
  stagingTestAuthDefaultSignInPath,
  stagingTestAuthAccount1SignInPath,
  stagingTestAuthAccount2SignInPath,
  `${stagingTestAuthBasePath}/get-session`,
  `${stagingTestAuthBasePath}/sign-out`,
]);

type StagingTestAuthAccount = {
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
};

type StagingTestAuthOptions = {
  enabled?: boolean;
  deploymentEnv?: string;
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  account2?: StagingTestAuthAccount;
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

const validateTestAuthAccount = (label: string, account: StagingTestAuthAccount): void => {
  if (
    !account.email ||
    !/^[^\s@]+@ku\.th$/.test(account.email) ||
    !account.password ||
    !isValidAdminPassword(account.password) ||
    !account.firstName ||
    !account.lastName
  ) {
    throw new Error(`${label} requires a valid @ku.th email, a compliant password, and a first and last name`);
  }
};

export const createStagingTestAuthRoute = (
  options: StagingTestAuthOptions = {},
) => {
  const settings = {
    enabled: options.enabled ?? env.stagingTestAuthEnabled,
    deploymentEnv: options.deploymentEnv ?? env.deploymentEnv,
    account1: {
      email:
        options.email?.trim().toLowerCase() ?? env.stagingTestAuthEmail?.trim().toLowerCase(),
      password: options.password ?? env.stagingTestAuthPassword,
      firstName: options.firstName ?? env.stagingTestAuthFirstName,
      lastName: options.lastName ?? env.stagingTestAuthLastName,
    },
    account2: {
      email:
        options.account2?.email?.trim().toLowerCase() ?? env.stagingTestAuthAccount2Email?.trim().toLowerCase(),
      password: options.account2?.password ?? env.stagingTestAuthAccount2Password,
      firstName: options.account2?.firstName ?? env.stagingTestAuthAccount2FirstName,
      lastName: options.account2?.lastName ?? env.stagingTestAuthAccount2LastName,
    },
  };
  const enabled = settings.enabled && settings.deploymentEnv === 'staging';

  if (enabled) {
    validateTestAuthAccount('Staging test auth', settings.account1);
    const account2IsConfigured = Object.values(settings.account2).some(Boolean);
    if (account2IsConfigured) validateTestAuthAccount('Staging Account 2 auth', settings.account2);
  }

  const accounts = [
    { key: 'account-1', signInPath: stagingTestAuthAccount1SignInPath, ...settings.account1 },
    ...(settings.account2.email
      ? [{ key: 'account-2', signInPath: stagingTestAuthAccount2SignInPath, ...settings.account2 }]
      : []),
  ];
  const account1 = accounts[0];
  if (!account1) throw new Error('Staging test Account 1 is missing');
  const accountBySignInPath = new Map(accounts.map((account) => [account.signInPath, account]));

  const testAuth = createStudentAuth({
    basePath: stagingTestAuthBasePath,
    emailAndPasswordEnabled: true,
    allowEmailSignUp: true,
    autoSignIn: false,
  });

  const ensureTestStudentPromises = new Map<string, Promise<void>>();

  const ensureTestStudent = async (account: (typeof accounts)[number]): Promise<void> => {
    const existingPromise = ensureTestStudentPromises.get(account.key);
    if (existingPromise) return existingPromise;

    const promise = (async () => {
      const existingStudent = await db
        .select({ id: authUser.id })
        .from(authUser)
        .where(eq(authUser.email, account.email!))
        .limit(1);

      let studentId = existingStudent[0]?.id;
      if (!studentId) {
        const result = await testAuth.api.signUpEmail({
          body: {
            email: account.email!,
            password: account.password!,
            name: `${account.firstName} ${account.lastName}`,
            firstName: account.firstName!,
            lastName: account.lastName!,
          },
        });

        if (!result.user) throw new Error('Staging test Student could not be created');
        studentId = result.user.id;
      }

      await ensureWallet(studentId);
    })();
    ensureTestStudentPromises.set(account.key, promise);

    try {
      await promise;
    } finally {
      ensureTestStudentPromises.delete(account.key);
    }
  };

  const authHandler = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;

    if (!enabled || !stagingTestAuthPaths.has(pathname)) {
      return new Response(null, { status: 404 });
    }

    if (pathname === stagingTestAuthDefaultSignInPath) {
      if (request.method !== 'POST') return new Response(null, { status: 404 });

      await ensureTestStudent(account1);
      return testAuth.handler(defaultSignInRequest(request, account1.email!, account1.password!));
    }

    const account = accountBySignInPath.get(pathname);
    if (account) {
      if (request.method !== 'POST') return new Response(null, { status: 404 });

      await ensureTestStudent(account);
      return testAuth.handler(defaultSignInRequest(request, account.email!, account.password!));
    }

    if (pathname === stagingTestAuthSignInPath) {
      const body = await readSignInBody(request);
      const matchesConfiguredCredentials =
        body?.email === account1.email && body?.password === account1.password;

      if (!matchesConfiguredCredentials) return invalidCredentialsResponse();

      await ensureTestStudent(account1);
    }

    return testAuth.handler(request);
  };

  return new Elysia({ name: 'staging-test-auth-route' }).mount(authHandler);
};

export const stagingTestAuthRoute = createStagingTestAuthRoute();
