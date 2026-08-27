import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

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
