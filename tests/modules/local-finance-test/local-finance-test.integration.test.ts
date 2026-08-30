import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('local finance test routes', () => {
  it('requires a normal authenticated session', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/local/test/transfer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountSatang: 100 }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('requires a normal authenticated session to read the test Wallet', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/local/test/wallet'),
    );

    expect(response.status).toBe(401);
  });
});
