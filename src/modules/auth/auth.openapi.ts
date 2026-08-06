import type { ElysiaOpenAPIConfig } from '@elysia/openapi';

import { ALLOWED_EMAIL_DOMAIN } from './auth.constants';

type OpenAPIDocumentation = NonNullable<
  ElysiaOpenAPIConfig['documentation']
>;
type OpenAPIComponents = NonNullable<OpenAPIDocumentation['components']>;
type OpenAPIPaths = NonNullable<OpenAPIDocumentation['paths']>;

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/AuthError' },
    },
  },
});

export const authOpenAPIComponents = {
  securitySchemes: {
    betterAuthSession: {
      type: 'apiKey',
      in: 'cookie',
      name: 'better-auth.session_token',
      description:
        'Better Auth session cookie. Browsers receive it after a successful Google callback and must send requests with credentials enabled.',
    },
    betterAuthAdminSession: {
      type: 'apiKey',
      in: 'cookie',
      name: 'kuquest-admin.session_token',
      description:
        'Admin Better Auth session cookie. Browsers receive it after a successful Admin credential login and must send requests with credentials enabled.',
    },
  },
  schemas: {
    AuthError: {
      type: 'object',
      required: ['message'],
      properties: {
        code: {
          type: 'string',
          example: 'INVALID_TOKEN',
        },
        message: {
          type: 'string',
          example: 'Invalid token',
        },
      },
    },
    AuthUser: {
      type: 'object',
      required: [
        'id',
        'name',
        'email',
        'emailVerified',
        'firstName',
        'lastName',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        id: {
          type: 'string',
          description: 'Application user identifier stored as user.user_id.',
        },
        name: {
          type: 'string',
          description: 'Display name returned by Google.',
        },
        email: {
          type: 'string',
          format: 'email',
          example: `student@${ALLOWED_EMAIL_DOMAIN}`,
        },
        emailVerified: {
          type: 'boolean',
          description: 'Whether Google verified the email address.',
        },
        image: {
          type: 'string',
          format: 'uri',
          nullable: true,
        },
        firstName: {
          type: 'string',
          description: 'Google given_name stored as user.first_name.',
        },
        lastName: {
          type: 'string',
          description: 'Google family_name stored as user.last_name.',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
    },
    AuthSession: {
      type: 'object',
      required: ['id', 'userId', 'expiresAt', 'createdAt', 'updatedAt'],
      properties: {
        id: { type: 'string' },
        userId: { type: 'string' },
        expiresAt: {
          type: 'string',
          format: 'date-time',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
        ipAddress: {
          type: 'string',
          nullable: true,
        },
        userAgent: {
          type: 'string',
          nullable: true,
        },
      },
    },
    AuthSessionResponse: {
      type: 'object',
      required: ['session', 'user'],
      properties: {
        session: { $ref: '#/components/schemas/AuthSession' },
        user: { $ref: '#/components/schemas/AuthUser' },
      },
    },
    AdminAuthUser: {
      type: 'object',
      required: [
        'id',
        'name',
        'email',
        'emailVerified',
        'firstName',
        'lastName',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        id: { type: 'string' },
        name: { type: 'string', description: 'Admin display name.' },
        email: { type: 'string', format: 'email' },
        emailVerified: { type: 'boolean' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        disabledAt: { type: 'string', format: 'date-time', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
      },
    },
    AdminAuthSessionResponse: {
      type: 'object',
      required: ['session', 'user'],
      properties: {
        session: { $ref: '#/components/schemas/AuthSession' },
        user: { $ref: '#/components/schemas/AdminAuthUser' },
      },
    },
    AdminAuthSignInResponse: {
      type: 'object',
      required: ['redirect', 'token', 'user'],
      properties: {
        redirect: { type: 'boolean' },
        token: { type: 'string' },
        url: { type: 'string', format: 'uri', nullable: true },
        user: { $ref: '#/components/schemas/AdminAuthUser' },
      },
    },
    SocialSignInRequest: {
      type: 'object',
      required: ['provider'],
      properties: {
        provider: {
          type: 'string',
          enum: ['google'],
          description: 'Google is the only enabled provider.',
        },
        callbackURL: {
          type: 'string',
          format: 'uri',
          description: 'Trusted application URL used after successful sign-in.',
        },
        errorCallbackURL: {
          type: 'string',
          format: 'uri',
          description: 'Trusted application URL used when OAuth fails.',
        },
        newUserCallbackURL: {
          type: 'string',
          format: 'uri',
          description: 'Optional trusted URL used after the first sign-in.',
        },
        disableRedirect: {
          type: 'boolean',
          default: false,
          description:
            'When true, return the Google authorization URL for the browser to navigate manually.',
        },
        idToken: {
          type: 'object',
          description:
            'Presence switches this endpoint from the browser redirect flow to the native flow: the Google ID token from a mobile Google Sign-In SDK (the flow `@better-auth/expo` drives on Android), verified and signed in synchronously — no authorization URL is returned.',
          required: ['token'],
          properties: {
            token: { type: 'string', description: 'ID token issued by Google.' },
            nonce: { type: 'string', description: 'Nonce used to generate the token, if one was set.' },
            accessToken: { type: 'string', description: 'Google\'s OAuth access token, stored against the linked account.' },
            refreshToken: { type: 'string', description: 'Google\'s OAuth refresh token, stored against the linked account.' },
            expiresAt: { type: 'number', description: 'Unix timestamp the access token expires at.' },
          },
        },
      },
      example: {
        provider: 'google',
        callbackURL: 'http://localhost:5000/',
        errorCallbackURL: 'http://localhost:5000/',
        disableRedirect: true,
      },
    },
    SocialSignInResponse: {
      type: 'object',
      required: ['url', 'redirect'],
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Google authorization URL containing state and PKCE data.',
        },
        redirect: {
          type: 'boolean',
          description: 'Whether the client should redirect automatically.',
        },
      },
    },
    SocialSignInIdTokenResponse: {
      type: 'object',
      description: 'Returned instead of SocialSignInResponse when the request included idToken.',
      required: ['redirect', 'token', 'user'],
      properties: {
        redirect: {
          type: 'boolean',
          enum: [false],
          description: 'Always false for this flow — the caller already has a session, no authorization URL to follow.',
        },
        token: {
          type: 'string',
          description:
            'Session token as a flat string — unlike GET /api/auth/get-session\'s nested {session, user} shape. The Better Auth session cookie is also set on this response.',
        },
        user: { $ref: '#/components/schemas/AuthUser' },
      },
    },
    SignOutResponse: {
      type: 'object',
      required: ['success'],
      properties: {
        success: {
          type: 'boolean',
          enum: [true],
        },
      },
      example: { success: true },
    },
    RevokeSessionResult: {
      type: 'object',
      required: ['status'],
      properties: {
        status: {
          type: 'boolean',
          description: 'Whether the revocation completed successfully.',
        },
      },
      example: { status: true },
    },
  },
} satisfies OpenAPIComponents;

export const authOpenAPIPaths = {
  '/api/auth/sign-in/social': {
    post: {
      tags: ['Auth'],
      summary: 'Start Google sign-in',
      description: `Two flows share this endpoint, distinguished by whether the request body includes idToken. Without it (browser/redirect flow): creates a state- and PKCE-protected Google OAuth request and returns an authorization URL to navigate to. With it (native flow, e.g. Android via @better-auth/expo): verifies the ID token and signs in synchronously, returning a session. Only verified Google Workspace accounts in the ${ALLOWED_EMAIL_DOMAIN} domain may complete sign-in, on either flow.`,
      operationId: 'signInWithGoogle',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SocialSignInRequest' },
          },
        },
      },
      responses: {
        200: {
          description:
            'Redirect flow: Google authorization request created successfully. Native idToken flow: signed in successfully, session established.',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/SocialSignInResponse' },
                  { $ref: '#/components/schemas/SocialSignInIdTokenResponse' },
                ],
              },
            },
          },
        },
        400: errorResponse('Invalid provider, callback URL, or request body.'),
        401: errorResponse(
          `A native ID token (the mobile sign-in flow) fails Google's own hosted-domain check before this app's own validation ever runs, for e.g. an account outside the ${ALLOWED_EMAIL_DOMAIN} domain. Returns the generic Better Auth shape { code: "INVALID_TOKEN", message: "Invalid token" }, not a domain-specific error.`,
        ),
        429: errorResponse('Too many authentication requests.'),
        500: errorResponse('The authorization request could not be created.'),
      },
    },
  },
  '/api/admin/auth/sign-in/email': {
    post: {
      tags: ['Auth'],
      summary: 'Sign in an Admin with email and password',
      description:
        'Authenticates an Admin with credentials and sets the isolated Admin Better Auth session cookie. Public Admin signup is disabled.',
      operationId: 'signInAdminWithEmail',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password'],
              properties: {
                email: { type: 'string', format: 'email' },
                password: { type: 'string', minLength: 8, maxLength: 25 },
                rememberMe: {
                  type: 'boolean',
                  default: true,
                  description: 'Whether the session should be remembered.',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Admin authenticated successfully.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AdminAuthSignInResponse' },
            },
          },
        },
        401: errorResponse('The Admin email or password is invalid.'),
      },
    },
  },
  '/api/auth/callback/google': {
    get: {
      tags: ['Auth'],
      summary: 'Complete the Google OAuth callback',
      description:
        'Google redirects the browser to this endpoint. Better Auth validates state and PKCE, creates or updates the local account and session, sets the session cookie, then redirects to the trusted application callback URL. This endpoint is not intended to be called manually.',
      operationId: 'completeGoogleCallback',
      security: [],
      parameters: [
        {
          name: 'code',
          in: 'query',
          description: 'Authorization code issued by Google on success.',
          schema: { type: 'string' },
        },
        {
          name: 'state',
          in: 'query',
          description: 'OAuth state value created during sign-in.',
          schema: { type: 'string' },
        },
        {
          name: 'error',
          in: 'query',
          description: 'OAuth error code returned by Google.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        302: {
          description:
            `Redirects to the trusted callback URL and sets the Better Auth session cookie after successful authentication. On failure — including an account outside the ${ALLOWED_EMAIL_DOMAIN} domain, which fails Google's own hosted-domain check before this app's own validation ever runs — redirects to the trusted error callback URL instead, with an \`?error=<code>\` query param appended (e.g. \`unable_to_get_user_info\` for a rejected domain) rather than a JSON error body.`,
          headers: {
            Location: {
              description: 'Trusted frontend or API callback URL, or the error callback URL with an appended `error` query param on failure.',
              schema: { type: 'string', format: 'uri' },
            },
          },
        },
        400: errorResponse('Google rejected the request or OAuth state validation failed.'),
      },
    },
  },
  '/api/auth/get-session': {
    get: {
      tags: ['Auth'],
      summary: 'Get the current session',
      description:
        'Returns the current database-backed session and user. An unauthenticated request returns JSON null with status 200.',
      operationId: 'getAuthSession',
      security: [{ betterAuthSession: [] }],
      responses: {
        200: {
          description: 'Current session details, or null when unauthenticated.',
          content: {
            'application/json': {
              schema: {
                allOf: [{ $ref: '#/components/schemas/AuthSessionResponse' }],
                nullable: true,
              },
              examples: {
                authenticated: {
                  summary: 'Authenticated user',
                  value: {
                    session: {
                      id: 'session-id',
                      userId: 'user-id',
                      expiresAt: '2026-07-20T12:00:00.000Z',
                      createdAt: '2026-07-13T12:00:00.000Z',
                      updatedAt: '2026-07-13T12:00:00.000Z',
                    },
                    user: {
                      id: 'user-id',
                      name: 'KU Student',
                      email: `student@${ALLOWED_EMAIL_DOMAIN}`,
                      emailVerified: true,
                      image: null,
                      firstName: 'KU',
                      lastName: 'Student',
                      createdAt: '2026-07-13T12:00:00.000Z',
                      updatedAt: '2026-07-13T12:00:00.000Z',
                    },
                  },
                },
                unauthenticated: {
                  summary: 'No active session',
                  value: null,
                },
              },
            },
          },
        },
        500: errorResponse('The session could not be read.'),
      },
    },
  },
  '/api/admin/auth/get-session': {
    get: {
      tags: ['Auth'],
      summary: 'Get the current Admin session',
      description:
        'Returns the current Admin session. An unauthenticated request returns JSON null with status 200.',
      operationId: 'getAdminAuthSession',
      security: [{ betterAuthAdminSession: [] }],
      responses: {
        200: {
          description: 'Current Admin session details, or null when unauthenticated.',
          content: {
            'application/json': {
              schema: {
                allOf: [{ $ref: '#/components/schemas/AdminAuthSessionResponse' }],
                nullable: true,
              },
            },
          },
        },
        500: errorResponse('The Admin session could not be read.'),
      },
    },
  },
  '/api/auth/list-sessions': {
    get: {
      tags: ['Auth'],
      summary: 'List active sessions',
      description:
        'Lists every active (non-expired) session for the current user. Requires a fresh session — one created within the last 24 hours — even though the session itself may still be valid and rolling; a session kept alive purely by refresh without a recent sign-in is rejected with 403.',
      operationId: 'listUserSessions',
      security: [{ betterAuthSession: [] }],
      responses: {
        200: {
          description: 'Active sessions for the current user.',
          content: {
            'application/json': {
              schema: { type: 'array', items: { $ref: '#/components/schemas/AuthSession' } },
            },
          },
        },
        401: errorResponse('No active session.'),
        403: errorResponse('The session is valid but not fresh (created more than 24 hours ago); sign in again to refresh it.'),
      },
    },
  },
  '/api/auth/revoke-session': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke a single session',
      description:
        'Revokes one of the current user\'s own sessions by token. Immediate — sessions are database-backed, no token blocklisting involved.',
      operationId: 'revokeSession',
      security: [{ betterAuthSession: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['token'],
              properties: {
                token: { type: 'string', description: 'The session token to revoke.' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Session revoked (or was already gone/not owned by the caller — same response either way).',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RevokeSessionResult' },
            },
          },
        },
        401: errorResponse('No active session.'),
      },
    },
  },
  '/api/auth/revoke-sessions': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke every session',
      description: 'Revokes every session for the current user, including the one making this request.',
      operationId: 'revokeSessions',
      security: [{ betterAuthSession: [] }],
      responses: {
        200: {
          description: 'All sessions revoked.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RevokeSessionResult' },
            },
          },
        },
        401: errorResponse('No active session.'),
      },
    },
  },
  '/api/auth/revoke-other-sessions': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke every other session',
      description: 'Revokes every session for the current user except the one making this request.',
      operationId: 'revokeOtherSessions',
      security: [{ betterAuthSession: [] }],
      responses: {
        200: {
          description: 'All other sessions revoked.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RevokeSessionResult' },
            },
          },
        },
        401: errorResponse('No active session.'),
      },
    },
  },
  '/api/auth/sign-out': {
    post: {
      tags: ['Auth'],
      summary: 'Sign out the current user',
      description:
        'Deletes the database session when present and clears the Better Auth session cookie.',
      operationId: 'signOutCurrentUser',
      security: [{ betterAuthSession: [] }],
      responses: {
        200: {
          description: 'Session cookie cleared successfully.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SignOutResponse' },
            },
          },
        },
        500: errorResponse('The session could not be deleted.'),
      },
    },
  },
  '/api/admin/auth/sign-out': {
    post: {
      tags: ['Auth'],
      summary: 'Sign out the current Admin',
      description:
        'Deletes the database Admin session when present and clears the isolated Admin Better Auth session cookie.',
      operationId: 'signOutAdmin',
      security: [{ betterAuthAdminSession: [] }],
      responses: {
        200: {
          description: 'Admin session cookie cleared successfully.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SignOutResponse' },
            },
          },
        },
        500: errorResponse('The Admin session could not be deleted.'),
      },
    },
  },
} satisfies OpenAPIPaths;
