import { app } from '@/app';
import { env } from '@/config/env';
import { db, sql } from '@/database/client';
import { paymentProviderEventInbox } from '@/database/schema/payment.schema';

import { beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';

beforeAll(async () => {
  await sql`select 1`;
});

describe('Xendit Payout webhook route', () => {
  it('rejects a callback with an invalid authentication token', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/webhooks/xendit/payouts', {
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

  it('persists a valid callback before returning 202', async () => {
    const eventId = `be117-route-${crypto.randomUUID()}`;
    const rawPayload = JSON.stringify({
      event_id: eventId,
      event: 'v3_payout.pending_compliance',
      data: {
        payout_id: `po-${crypto.randomUUID()}`,
        reference_id: `payout:be117-route-${crypto.randomUUID()}`,
        status: 'PENDING_COMPLIANCE_REVIEW',
        source_amount: 100,
        source_currency: 'THB',
        destination_currency: 'THB',
      },
    });
    const previousConfig = {
      xenditWebhookToken: env.xenditWebhookToken,
      paymentProviderEventEncryptionKey: env.paymentProviderEventEncryptionKey,
      paymentProviderEventEncryptionKeyVersion: env.paymentProviderEventEncryptionKeyVersion,
    };
    Object.assign(env, {
      xenditWebhookToken: 'be117-route-token',
      paymentProviderEventEncryptionKey: 'b'.repeat(32),
      paymentProviderEventEncryptionKeyVersion: 'v1',
    });

    let response: Response;
    try {
      response = await app.handle(
        new Request('http://localhost/api/v1/webhooks/xendit/payouts', {
          method: 'POST',
          headers: {
            'x-callback-token': 'be117-route-token',
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
      resourceType: 'PAYOUT',
      processingStatus: 'RECEIVED',
      rawPayloadCiphertext: expect.any(String),
    });
  });

  it('documents the accepted response and authentication scheme', async () => {
    const response = await app.handle(
      new Request('http://localhost/openapi/json'),
    );
    const document = await response.json();
    const operation = document.paths['/api/v1/webhooks/xendit/payouts'].post;

    expect(response.status).toBe(200);
    expect(operation.responses['202']).toBeDefined();
    expect(operation.security).toEqual([{ xenditWebhookAuth: [] }]);
  });
});
