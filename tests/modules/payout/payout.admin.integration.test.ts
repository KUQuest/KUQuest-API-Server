import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('Payout API routes', () => {
  it('requires Member authentication for Student Payout endpoints', async () => {
    const quote = await app.handle(new Request('http://localhost/api/v1/payouts/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiptSatang: 100 }),
    }));
    const list = await app.handle(new Request('http://localhost/api/v1/payouts'));

    expect(quote.status).toBe(401);
    expect(list.status).toBe(401);
  });

  it('requires Admin authentication for Admin Payout endpoints', async () => {
    const list = await app.handle(new Request('http://localhost/api/v1/admin/payouts'));
    const approval = await app.handle(new Request('http://localhost/api/v1/admin/payouts/018f47a7-1c7d-7c98-9a11-690d7e83430c/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'admin-auth-check',
      },
      body: JSON.stringify({}),
    }));

    expect(list.status).toBe(401);
    expect(approval.status).toBe(401);
  });

  it('publishes Student and Admin Payout contracts in OpenAPI', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json() as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };

    expect(response.status).toBe(200);
    expect(document.paths['/api/v1/payouts']?.post?.operationId).toBe('createPayout');
    expect(document.paths['/api/v1/payouts']?.get?.operationId).toBe('listPayouts');
    expect(document.paths['/api/v1/admin/payouts']?.get?.operationId).toBe('listAdminPayouts');
    expect(document.paths['/api/v1/admin/payouts/{payoutId}/approve']?.post?.operationId).toBe('approvePayout');
    expect(document.paths['/api/v1/admin/payouts/{payoutId}/reject']?.post?.operationId).toBe('rejectPayout');
  });
});
