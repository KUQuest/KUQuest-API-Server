import { Elysia } from 'elysia';

import { adminAuth } from './admin-auth.config';
import { auth } from './auth.config';

const adminAuthBasePath = '/api/admin/auth';
const adminAuthPaths = new Set([
  `${adminAuthBasePath}/sign-in/email`,
  `${adminAuthBasePath}/get-session`,
  `${adminAuthBasePath}/sign-out`,
]);

const studentAuthBasePath = '/api/auth';
const studentAuthPaths = new Set([
  `${studentAuthBasePath}/sign-in/social`,
  `${studentAuthBasePath}/callback/google`,
  `${studentAuthBasePath}/get-session`,
  `${studentAuthBasePath}/list-sessions`,
  `${studentAuthBasePath}/revoke-session`,
  `${studentAuthBasePath}/revoke-sessions`,
  `${studentAuthBasePath}/revoke-other-sessions`,
  `${studentAuthBasePath}/sign-out`,
]);

const authHandler = (request: Request) => {
  const pathname = new URL(request.url).pathname;

  if (
    pathname === adminAuthBasePath ||
    pathname.startsWith(`${adminAuthBasePath}/`)
  ) {
    if (!adminAuthPaths.has(pathname)) return new Response(null, { status: 404 });

    return adminAuth.handler(request);
  }

  if (!studentAuthPaths.has(pathname)) return new Response(null, { status: 404 });

  return auth.handler(request);
};

export const authPlugin = new Elysia({
  name: 'auth-plugin',
}).mount(authHandler);
