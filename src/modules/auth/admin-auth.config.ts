import { env } from '@/config/env';
import { db } from '@/database/client';
import * as schema from '@/database/schema/auth.schema';

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import {
  configurationPlaceholder,
  defaultCookieAttributes,
  getTrustedOrigins,
} from './auth.config.shared';

type AdminAuthOptions = {
  allowSignUp?: boolean;
  autoSignIn?: boolean;
  markEmailVerified?: boolean;
};

export const createAdminAuth = ({
  allowSignUp = false,
  autoSignIn = true,
  markEmailVerified = false,
}: AdminAuthOptions = {}) =>
  betterAuth({
    appName: 'KUQuest Admin',
    baseURL: env.betterAuthUrl || 'http://localhost:5000',
    basePath: '/api/admin/auth',
    secret:
      env.adminBetterAuthSecret || configurationPlaceholder('admin-auth-secret'),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 25,
      autoSignIn,
    },
    rateLimit: {
      enabled: false,
    },
    user: {
      modelName: 'authAdmin',
      fields: {
        name: 'firstName',
      },
      additionalFields: {
        firstName: {
          type: 'string',
          required: true,
        },
        lastName: {
          type: 'string',
          required: true,
        },
        disabledAt: {
          type: 'date',
          required: false,
          input: false,
        },
      },
    },
    session: {
      modelName: 'authSession',
      fields: {
        userId: 'adminId',
      },
    },
    account: {
      modelName: 'authAccount',
      fields: {
        userId: 'adminId',
      },
    },
    verification: {
      modelName: 'authVerification',
    },
    advanced: {
      cookiePrefix: 'kuquest-admin',
      defaultCookieAttributes,
    },
    trustedOrigins: getTrustedOrigins(),
    databaseHooks: markEmailVerified
      ? {
          user: {
            create: {
              before: async (user) => ({
                data: { ...user, emailVerified: true },
              }),
            },
          },
        }
      : undefined,
  });

export const adminAuth = createAdminAuth();

export type AdminAuthSession = typeof adminAuth.$Infer.Session;
