import { Elysia, t } from 'elysia';

import {
  apiFailure,
  apiFailureSchema,
  apiSuccess,
  apiSuccessSchema,
} from '@/http/api-response';
import {
  assertTrustedBrowserOrigin,
  CsrfError,
  isAllowedEmail,
} from '@/modules/auth';

import { actorCookie, readCookie } from './dev-test.cookie';
import { createOpaqueActorToken, hashActorToken } from './dev-test.crypto';
import { DevelopmentTestError } from './dev-test.errors';
import {
  developmentSessionContextSchema,
  developmentTestUserSchema,
} from './dev-test.schema';
import {
  DEVELOPMENT_ACTOR_COOKIE,
  type DevelopmentTestRouteOptions,
  type DevelopmentUserSummary,
} from './dev-test.types';

const DEFAULT_ACTOR_SESSION_TTL_SECONDS = 8 * 60 * 60;

const assertEnabled = (enabled: boolean): void => {
  if (!enabled) {
    throw new DevelopmentTestError(
      404,
      'DEVELOPMENT_FEATURE_DISABLED',
      'Development test routes are not available.',
    );
  }
};

const rootUser = async (
  options: DevelopmentTestRouteOptions,
  headers: Headers,
): Promise<DevelopmentUserSummary> => {
  assertEnabled(options.enabled);
  const session = await options.rootSessionResolver(headers);
  if (!session?.user.id) {
    throw new DevelopmentTestError(
      401,
      'UNAUTHORIZED',
      'A valid Better Auth session is required.',
    );
  }

  const root = await options.repository.getRealUser(session.user.id);
  if (!root || !isAllowedEmail(root.email)) {
    throw new DevelopmentTestError(
      403,
      'FORBIDDEN',
      'A real @ku.th account is required for development actor access.',
    );
  }
  return root;
};

const responseSchemas = {
  401: apiFailureSchema,
  403: apiFailureSchema,
  404: apiFailureSchema,
  422: apiFailureSchema,
};

export const createDevelopmentTestRoute = (
  options: DevelopmentTestRouteOptions,
) => {
  const cookieName = options.cookieName ?? DEVELOPMENT_ACTOR_COOKIE;
  const ttlSeconds =
    options.actorSessionTtlSeconds ?? DEFAULT_ACTOR_SESSION_TTL_SECONDS;

  return new Elysia({
    name: 'development-test-route',
    prefix: '/v1/development',
  })
    .onError(({ error, request, status }) => {
      if (error instanceof CsrfError) {
        return status(
          error.status,
          apiFailure(error.status, error.code, error.message, request),
        );
      }
      if (!(error instanceof DevelopmentTestError)) return undefined;
      return status(
        error.status,
        apiFailure(error.status, error.code, error.message, request),
      );
    })
    .get(
      '/test-users',
      async ({ request }) => {
        await rootUser(options, request.headers);
        return apiSuccess(
          { items: await options.repository.listTestUsers() },
          request,
        );
      },
      {
        response: {
          200: apiSuccessSchema(
            t.Object({ items: t.Array(developmentTestUserSchema) }),
          ),
          ...responseSchemas,
        },
        detail: {
          tags: ['Development test'],
          summary: 'List shared synthetic normal users',
          operationId: 'listDevelopmentTestUsers',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/test-users',
      async ({ body, request, status }) => {
        const root = await rootUser(options, request.headers);
        assertTrustedBrowserOrigin(request.headers, options.trustedOrigins);
        const displayName =
          'name' in body
            ? body.name.trim()
            : `${body.first_name} ${body.last_name}`.trim();
        const parts = displayName.split(/\s+/).filter(Boolean);
        const firstName =
          'first_name' in body ? body.first_name.trim() : (parts[0] ?? '');
        const lastName =
          'last_name' in body
            ? body.last_name.trim()
            : parts.slice(1).join(' ') || 'Test';
        if (!firstName || !lastName) {
          throw new DevelopmentTestError(
            422,
            'VALIDATION_FAILED',
            'First name and last name must contain visible characters.',
          );
        }
        const created = await options.repository.createTestUser({
          createdByUserId: root.id,
          displayName,
          firstName,
          lastName,
        });
        return status(201, apiSuccess(created, request));
      },
      {
        body: t.Union([
          t.Object({ name: t.String({ minLength: 1, maxLength: 160 }) }),
          t.Object({
            first_name: t.String({ minLength: 1, maxLength: 80 }),
            last_name: t.String({ minLength: 1, maxLength: 80 }),
          }),
        ]),
        response: {
          201: apiSuccessSchema(developmentTestUserSchema),
          ...responseSchemas,
        },
        detail: {
          tags: ['Development test'],
          summary: 'Create a zero-balance synthetic normal user',
          operationId: 'createDevelopmentTestUser',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .post(
      '/actor-sessions',
      async ({ body, request, set, status }) => {
        const root = await rootUser(options, request.headers);
        assertTrustedBrowserOrigin(request.headers, options.trustedOrigins);
        const token = createOpaqueActorToken();
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
        const actorSession = await options.repository.createActorSession({
          tokenHash: hashActorToken(token),
          userId: body.user_id,
          activatedByUserId: root.id,
          expiresAt,
        });
        if (!actorSession) {
          throw new DevelopmentTestError(
            404,
            'NOT_FOUND',
            'The synthetic user was not found.',
          );
        }
        set.headers['set-cookie'] = actorCookie({
          name: cookieName,
          value: token,
          maxAgeSeconds: ttlSeconds,
          secure: options.secureCookie ?? false,
        });
        return status(
          201,
          apiSuccess(
            {
              active_user: actorSession.actor,
              actor_session_expires_at: actorSession.expires_at,
            },
            request,
          ),
        );
      },
      {
        body: t.Object({ user_id: t.String({ minLength: 1 }) }),
        response: {
          201: apiSuccessSchema(
            t.Object({
              active_user: developmentTestUserSchema,
              actor_session_expires_at: t.String({ format: 'date-time' }),
            }),
          ),
          ...responseSchemas,
        },
        detail: {
          tags: ['Development test'],
          summary: 'Activate a shared synthetic user for this browser',
          operationId: 'createDevelopmentActorSession',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .delete(
      '/actor-session',
      async ({ request, set }) => {
        const root = await rootUser(options, request.headers);
        assertTrustedBrowserOrigin(request.headers, options.trustedOrigins);
        const token = readCookie(request.headers, cookieName);
        if (token) {
          await options.repository.deleteActorSession({
            tokenHash: hashActorToken(token),
            activatedByUserId: root.id,
          });
        }
        set.headers['set-cookie'] = actorCookie({
          name: cookieName,
          value: '',
          maxAgeSeconds: 0,
          secure: options.secureCookie ?? false,
        });
        return apiSuccess({ cleared: true }, request);
      },
      {
        response: {
          200: apiSuccessSchema(t.Object({ cleared: t.Literal(true) })),
          ...responseSchemas,
        },
        detail: {
          tags: ['Development test'],
          summary: 'Clear the active synthetic user',
          operationId: 'deleteDevelopmentActorSession',
          security: [{ betterAuthSession: [] }],
        },
      },
    )
    .get(
      '/session-context',
      async ({ request }) => {
        const root = await rootUser(options, request.headers);
        const token = readCookie(request.headers, cookieName);
        const actorSession = token
          ? await options.repository.resolveActorSession({
              tokenHash: hashActorToken(token),
              activatedByUserId: root.id,
              now: new Date(),
            })
          : null;
        return apiSuccess(
          {
            root_user: root,
            active_user: actorSession?.actor ?? root,
            acting_as_test_user: actorSession !== null,
            actor_session_expires_at: actorSession?.expires_at ?? null,
          },
          request,
        );
      },
      {
        response: {
          200: apiSuccessSchema(developmentSessionContextSchema),
          ...responseSchemas,
        },
        detail: {
          tags: ['Development test'],
          summary: 'Get the real and effective development session users',
          operationId: 'getDevelopmentSessionContext',
          security: [{ betterAuthSession: [] }],
        },
      },
    );
};
