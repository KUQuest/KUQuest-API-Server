import { env } from '@/config/env';

import { Buffer } from 'node:buffer';
import { createSign } from 'node:crypto';

const oauthTokenUrl = 'https://oauth2.googleapis.com/token';
const fcmScope = 'https://www.googleapis.com/auth/firebase.messaging';

type FcmErrorBody = {
  error?: {
    status?: string;
    details?: Array<{ errorCode?: string }>;
  };
};

export type AndroidPushMessage = {
  title: string;
  body: string;
  deepLink: string;
  data: Record<string, string>;
};

export type AndroidPushResult =
  | { kind: 'DELIVERED' }
  | { kind: 'INVALID_DESTINATION'; errorCode: string }
  | { kind: 'RETRYABLE_FAILURE'; errorCode: string }
  | { kind: 'PERMANENT_FAILURE'; errorCode: string };

export type PushFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FcmPushProviderOptions = {
  projectId?: string;
  clientEmail?: string;
  privateKey?: string;
  fetcher?: PushFetch;
  now?: () => number;
};

export const isFcmPushConfigured = () =>
  Boolean(env.fcmProjectId && env.fcmClientEmail && env.fcmPrivateKey);

const base64UrlJson = (value: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export const createFcmPushProvider = (options: FcmPushProviderOptions = {}) => {
  const projectId = options.projectId ?? env.fcmProjectId;
  const clientEmail = options.clientEmail ?? env.fcmClientEmail;
  const privateKey = options.privateKey ?? env.fcmPrivateKey?.replace(/\\n/g, '\n');
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cachedAccessToken: { value: string; expiresAt: number } | undefined;

  const getAccessToken = async (): Promise<string | null> => {
    if (!clientEmail || !privateKey) return null;
    if (cachedAccessToken && cachedAccessToken.expiresAt > now() + 60_000) {
      return cachedAccessToken.value;
    }

    const issuedAt = Math.floor(now() / 1_000);
    const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
    const claim = base64UrlJson({
      iss: clientEmail,
      scope: fcmScope,
      aud: oauthTokenUrl,
      iat: issuedAt,
      exp: issuedAt + 3_600,
    });
    const unsignedToken = `${header}.${claim}`;
    const signer = createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();
    const assertion = `${unsignedToken}.${signer.sign(privateKey).toString('base64url')}`;

    let response: Response;
    try {
      response = await fetcher(oauthTokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }),
      });
    } catch {
      throw new Error('FCM_OAUTH_NETWORK_ERROR');
    }

    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new Error('FCM_OAUTH_RETRYABLE_ERROR');
      }
      throw new Error('FCM_OAUTH_AUTH_FAILED');
    }

    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new Error('FCM_OAUTH_INVALID_RESPONSE');
    }

    cachedAccessToken = {
      value: body.access_token,
      expiresAt: now() + body.expires_in * 1_000,
    };
    return cachedAccessToken.value;
  };

  const send = async (token: string, message: AndroidPushMessage): Promise<AndroidPushResult> => {
    if (!projectId || !clientEmail || !privateKey) {
      return { kind: 'RETRYABLE_FAILURE', errorCode: 'FCM_NOT_CONFIGURED' };
    }

    let accessToken: string;
    try {
      const value = await getAccessToken();
      if (!value) return { kind: 'RETRYABLE_FAILURE', errorCode: 'FCM_NOT_CONFIGURED' };
      accessToken = value;
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : 'FCM_OAUTH_ERROR';
      return {
        kind: errorCode === 'FCM_OAUTH_AUTH_FAILED' ? 'PERMANENT_FAILURE' : 'RETRYABLE_FAILURE',
        errorCode,
      };
    }

    let response: Response;
    try {
      response = await fetcher(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            message: {
              token,
              data: {
                ...message.data,
                title: message.title,
                body: message.body,
                link: message.deepLink,
              },
              android: {
                priority: 'HIGH',
              },
            },
          }),
        }
      );
    } catch {
      return { kind: 'RETRYABLE_FAILURE', errorCode: 'FCM_NETWORK_ERROR' };
    }

    if (response.ok) return { kind: 'DELIVERED' };

    const body = (await response.json().catch(() => ({}))) as FcmErrorBody;
    const fcmErrorCode = body.error?.details?.find((detail) => detail.errorCode)?.errorCode;
    if (
      fcmErrorCode === 'UNREGISTERED' ||
      fcmErrorCode === 'SENDER_ID_MISMATCH' ||
      fcmErrorCode === 'INVALID_ARGUMENT'
    ) {
      return { kind: 'INVALID_DESTINATION', errorCode: fcmErrorCode };
    }
    if (response.status === 429 || response.status >= 500) {
      return {
        kind: 'RETRYABLE_FAILURE',
        errorCode: fcmErrorCode ?? `FCM_HTTP_${response.status}`,
      };
    }
    return { kind: 'PERMANENT_FAILURE', errorCode: fcmErrorCode ?? `FCM_HTTP_${response.status}` };
  };

  return { send };
};
