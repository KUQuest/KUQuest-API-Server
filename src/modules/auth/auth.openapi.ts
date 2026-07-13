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
  },
  schemas: {
    AuthError: {
      type: 'object',
      required: ['message'],
      properties: {
        code: {
          type: 'string',
          example: 'EMAIL_DOMAIN_NOT_ALLOWED',
        },
        message: {
          type: 'string',
          example: `Only @${ALLOWED_EMAIL_DOMAIN} Google accounts can sign in`,
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
  },
} satisfies OpenAPIComponents;

export const authOpenAPIPaths = {
  '/api/auth/sign-in/social': {
    post: {
      tags: ['Auth'],
      summary: 'Start Google sign-in',
      description: `Creates a state- and PKCE-protected Google OAuth request. Only verified Google Workspace accounts in the ${ALLOWED_EMAIL_DOMAIN} domain may complete sign-in.`,
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
          description: 'Google authorization request created successfully.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SocialSignInResponse' },
            },
          },
        },
        400: errorResponse('Invalid provider, callback URL, or request body.'),
        403: errorResponse(`The Google account is not in the ${ALLOWED_EMAIL_DOMAIN} domain.`),
        429: errorResponse('Too many authentication requests.'),
        500: errorResponse('The authorization request could not be created.'),
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
            'Redirects to the trusted callback URL and sets the Better Auth session cookie after successful authentication.',
          headers: {
            Location: {
              description: 'Trusted frontend or API callback URL.',
              schema: { type: 'string', format: 'uri' },
            },
          },
        },
        400: errorResponse('Google rejected the request or OAuth state validation failed.'),
        403: errorResponse(`Only @${ALLOWED_EMAIL_DOMAIN} Google accounts are allowed.`),
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
} satisfies OpenAPIPaths;
