import { app } from '@/app';
import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { paymentProviderEventInbox } from '@/database/schema/payment.schema';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await sql`select 1`;
});

describe('Xendit Top-up webhook route', () => {
  it('rejects a callback with an invalid authentication token', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/webhooks/xendit/payments', {
        method: 'POST',
        headers: { 'x-callback-token': 'invalid' },
        body: '{}',
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'UNAUTHORIZED' },
    });
  });

  it('persists a valid callback before returning 202 without applying financial effects', async () => {
    const eventId = `be116-route-${crypto.randomUUID()}`;
    const internalReference = `top-up:be116-route-${crypto.randomUUID()}`;
    const rawPayload = JSON.stringify({
      event: 'payment_request.status_updated',
      data: {
        reference_id: internalReference,
        payment_request_id: `pr-${crypto.randomUUID()}`,
        status: 'SUCCEEDED',
        request_amount: 1,
        channel_code: 'QRPROMPTPAY',
        updated: '2026-08-27T00:00:00.000Z',
      },
    });
    const previousConfig = {
      xenditWebhookToken: env.xenditWebhookToken,
      paymentProviderEventEncryptionKey: env.paymentProviderEventEncryptionKey,
      paymentProviderEventEncryptionKeyVersion: env.paymentProviderEventEncryptionKeyVersion,
    };
    Object.assign(env, {
      xenditWebhookToken: 'be116-route-token',
      paymentProviderEventEncryptionKey: 'a'.repeat(32),
      paymentProviderEventEncryptionKeyVersion: 'v1',
    });

    let response: Response;
    try {
      response = await app.handle(
        new Request('http://localhost/api/v1/webhooks/xendit/payments', {
          method: 'POST',
          headers: {
            'x-callback-token': 'be116-route-token',
            'webhook-id': eventId,
          },
          body: rawPayload,
        }),
      );
    } finally {
      Object.assign(env, previousConfig);
    }

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ success: true });
    const [stored] = await db.select().from(paymentProviderEventInbox).where(
      eq(paymentProviderEventInbox.providerEventId, eventId),
    );
    expect(stored).toMatchObject({
      providerEventId: eventId,
      internalReference,
      processingStatus: 'RECEIVED',
      rawPayloadCiphertext: expect.any(String),
    });
  });

  it('documents the provider authentication and accepted response', async () => {
    const response = await app.handle(
      new Request('http://localhost/openapi/json'),
    );
    const document = await response.json();
    const operation = document.paths['/api/v1/webhooks/xendit/payments'].post;

    expect(response.status).toBe(200);
    expect(operation.responses['202']).toBeDefined();
    expect(operation.security).toEqual([{ xenditWebhookAuth: [] }]);
    expect(document.components.securitySchemes.xenditWebhookAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-callback-token',
    });
  });
});
