import { env } from '@/config/env';
import { demoMembers } from '@/shared/demo-members';

import { Elysia } from 'elysia';

import { createStudentAuth } from './auth.config';
import { isValidAdminPassword } from './admin-auth.policy';

const stagingTestAuthBasePath = '/api/staging/test-auth';
const stagingTestAuthSignInPath = `${stagingTestAuthBasePath}/sign-in/email`;

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
    }
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
    throw new Error(
      `${label} requires a valid @ku.th email, a compliant password, and a first and last name`
    );
  }
};

export const createStagingTestAuthRoute = (options: StagingTestAuthOptions = {}) => {
  const enabled =
    (options.enabled ?? env.stagingTestAuthEnabled) &&
    (options.deploymentEnv ?? env.deploymentEnv) === 'staging';
  const password = options.password ?? env.stagingTestAuthPassword;
  // Explicit account injection is used by integration fixtures. Runtime identities
  // always come from the one demo Member catalog, never the old email/name env vars.
  const accounts = options.email
    ? [
        {
          key: 'account-1',
          email: options.email.trim().toLowerCase(),
          password,
          firstName: options.firstName,
          lastName: options.lastName,
        },
        ...(options.account2?.email ? [{ key: 'account-2', ...options.account2 }] : []),
      ]
    : demoMembers.map((member) => ({ ...member, password }));
  if (enabled) accounts.forEach((account) => validateTestAuthAccount('Demo login', account));
  const accountByPath = new Map(
    accounts.map((account) => [`${stagingTestAuthBasePath}/sign-in/${account.key}`, account])
  );
  // Read/sign-in only: missing seeded Members fail authentication. Login never
  // creates a Member, edits a Profile, or provisions a Wallet.
  const testAuth = createStudentAuth({
    basePath: stagingTestAuthBasePath,
    emailAndPasswordEnabled: true,
    allowEmailSignUp: false,
    autoSignIn: false,
    provisionWalletOnCreate: false,
  });
  const authHandler = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (!enabled) return new Response(null, { status: 404 });
    const account =
      pathname === `${stagingTestAuthBasePath}/sign-in/default`
        ? accounts[0]
        : accountByPath.get(pathname);
    if (account) {
      if (request.method !== 'POST') return new Response(null, { status: 404 });
      return testAuth.handler(defaultSignInRequest(request, account.email!, account.password!));
    }
    if (pathname === stagingTestAuthSignInPath) {
      if (request.method !== 'POST') return new Response(null, { status: 404 });
      const body = await readSignInBody(request);
      if (
        !accounts.some((item) => body?.email === item.email && body?.password === item.password)
      ) {
        return invalidCredentialsResponse();
      }
      return testAuth.handler(request);
    }
    if (
      (pathname === `${stagingTestAuthBasePath}/get-session` && request.method === 'GET') ||
      (pathname === `${stagingTestAuthBasePath}/sign-out` && request.method === 'POST')
    ) {
      return testAuth.handler(request);
    }
    return new Response(null, { status: 404 });
  };
  return new Elysia({ name: 'staging-test-auth-route' }).mount(authHandler);
};

export const stagingTestAuthRoute = createStagingTestAuthRoute();
