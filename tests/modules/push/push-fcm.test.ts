import { createFcmPushProvider } from '@/modules/push';
import type { PushFetch } from '@/modules/push';

import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

const createCredentials = () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2_048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
};

describe('Firebase Cloud Messaging provider', () => {
  it('sends Android Push through FCM HTTP v1 with the supplied event data', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: PushFetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
      }
      return Response.json({ name: 'projects/kuquest/messages/message-id' });
    };
    const provider = createFcmPushProvider({
      projectId: 'kuquest',
      clientEmail: 'push@kuquest.iam.gserviceaccount.com',
      privateKey: createCredentials(),
      fetcher,
      now: () => 1_000_000,
    });

    const result = await provider.send('fcm-device-token', {
      title: 'Conduct Report decision',
      body: 'Your Conduct Report was upheld. Reason: abandonment. Result: a 7-day Red Flag.',
      deepLink: 'kuquest://conduct-reports/CND-000001',
      data: { eventKey: 'conduct-report-upheld:report-id', decision: 'UPHELD' },
    });

    expect(result).toEqual({ kind: 'DELIVERED' });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe('https://fcm.googleapis.com/v1/projects/kuquest/messages:send');
    expect(requests[1]?.init?.headers).toMatchObject({
      authorization: 'Bearer test-access-token',
    });
    const outgoingPayload = JSON.parse(String(requests[1]?.init?.body)) as {
      message: Record<string, unknown>;
    };
    expect(outgoingPayload.message).not.toHaveProperty('notification');
    expect(outgoingPayload).toMatchObject({
      message: {
        token: 'fcm-device-token',
        data: {
          eventKey: 'conduct-report-upheld:report-id',
          decision: 'UPHELD',
          title: 'Conduct Report decision',
          body: expect.stringContaining('abandonment'),
          link: 'kuquest://conduct-reports/CND-000001',
        },
        android: { priority: 'HIGH' },
      },
    });
  });

  it('marks invalid destinations and retries transient provider failures', async () => {
    const privateKey = createCredentials();
    const providerFor = (sendResponse: Response) => {
      let callCount = 0;
      const fetcher: PushFetch = async () => {
        callCount += 1;
        if (callCount === 1) {
          return Response.json({ access_token: 'test-access-token', expires_in: 3600 });
        }
        return sendResponse;
      };
      return createFcmPushProvider({
        projectId: 'kuquest',
        clientEmail: 'push@kuquest.iam.gserviceaccount.com',
        privateKey,
        fetcher,
      });
    };
    const message = {
      title: 'Conduct Report decision',
      body: 'Your report was upheld.',
      deepLink: 'kuquest://conduct-reports/CND-000001',
      data: { eventKey: 'conduct-report-upheld:report-id' },
    };

    const invalid = await providerFor(
      Response.json(
        {
          error: {
            status: 'NOT_FOUND',
            details: [{ errorCode: 'UNREGISTERED' }],
          },
        },
        { status: 404 }
      )
    ).send('fcm-device-token', message);
    expect(invalid).toEqual({ kind: 'INVALID_DESTINATION', errorCode: 'UNREGISTERED' });

    const transient = await providerFor(new Response('unavailable', { status: 503 })).send(
      'fcm-device-token',
      message
    );
    expect(transient).toEqual({ kind: 'RETRYABLE_FAILURE', errorCode: 'FCM_HTTP_503' });
  });
});
