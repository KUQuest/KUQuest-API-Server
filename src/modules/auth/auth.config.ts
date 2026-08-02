import { env } from '@/config/env';
import { db } from '@/database/client';
import * as schema from '@/database/schema/auth.schema';

import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import { ALLOWED_EMAIL_DOMAIN } from './auth.constants';
import {
  configurationPlaceholder,
  defaultCookieAttributes,
  getTrustedOrigins,
} from './auth.config.shared';
import { assertAllowedEmail } from './auth.policy';

export const auth = betterAuth({
  appName: 'KUQuest',
  baseURL: env.betterAuthUrl || 'http://localhost:5000',
  secret: env.betterAuthSecret || configurationPlaceholder('auth-secret'),
  plugins: [expo()],
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema,
  }),
  emailAndPassword: {
    enabled: false,
  },
  socialProviders: {
    google: {
      clientId: env.googleClientId || configurationPlaceholder('google-client-id'),
      clientSecret:
        env.googleClientSecret || configurationPlaceholder('google-client-secret'),
      hd: ALLOWED_EMAIL_DOMAIN,
      prompt: 'select_account',
      mapProfileToUser: (profile) => {
        assertAllowedEmail(profile.email);

        return {
          firstName: profile.given_name ?? profile.name ?? '',
          lastName: profile.family_name ?? '',
        };
      },
    },
  },
  user: {
    modelName: 'authUser',
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
    },
  },
  session: {
    modelName: 'authSession',
  },
  account: {
    modelName: 'authAccount',
    encryptOAuthTokens: true,
  },
  verification: {
    modelName: 'authVerification',
  },
  advanced: {
    defaultCookieAttributes,
  },
  trustedOrigins: getTrustedOrigins(true),
});

export type AuthSession = typeof auth.$Infer.Session;
