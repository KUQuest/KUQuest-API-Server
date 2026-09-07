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

const createMountedAuthHandler = (
  basePath: string,
  allowedPaths: ReadonlySet<string>,
  handler: (request: Request) => Response | Promise<Response>,
) =>
  (request: Request): Response | Promise<Response> => {
    const requestUrl = new URL(request.url);
    const pathname = `${basePath}${requestUrl.pathname}`;

    if (!allowedPaths.has(pathname)) return new Response(null, { status: 404 });

    return handler(
      new Request(new URL(`${pathname}${requestUrl.search}`, request.url), request),
    );
  };

export const authPlugin = new Elysia({
  name: 'auth-plugin',
}).mount(
  `${adminAuthBasePath}/*`,
  createMountedAuthHandler(adminAuthBasePath, adminAuthPaths, adminAuth.handler),
).mount(
  `${studentAuthBasePath}/*`,
  createMountedAuthHandler(studentAuthBasePath, studentAuthPaths, auth.handler),
);
