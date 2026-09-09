import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('Top-up HTTP routes', () => {
  it('requires Member authentication for all Top-up operations', async () => {
    const requests = [
      new Request('http://localhost/api/v1/top-ups/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ creditSatang: 100 }),
      }),
      new Request('http://localhost/api/v1/top-ups', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'top-up-http-auth-check',
        },
        body: JSON.stringify({ quoteId: crypto.randomUUID() }),
      }),
      new Request('http://localhost/api/v1/top-ups'),
      new Request(`http://localhost/api/v1/top-ups/${crypto.randomUUID()}`),
      new Request(`http://localhost/api/v1/top-ups/${crypto.randomUUID()}/status-history`),
    ];

    const responses = await Promise.all(requests.map((request) => app.handle(request)));

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
  });

  it('publishes the Member Top-up and Payout HTTP contracts in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/top-ups/quotes']?.post?.operationId).toBe('quoteTopUp');
    expect(document.paths['/api/v1/top-ups']?.post?.operationId).toBe('createTopUp');
    expect(document.paths['/api/v1/top-ups']?.get?.operationId).toBe('listTopUps');
    expect(document.paths['/api/v1/top-ups/{topUpId}']?.get?.operationId).toBe('getTopUp');
    expect(document.paths['/api/v1/top-ups/{topUpId}/status-history']?.get?.operationId)
      .toBe('listTopUpStatusHistory');
    expect(document.paths['/api/v1/payouts']?.post?.operationId).toBe('createPayout');
  });
});
