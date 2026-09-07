import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('Wallet route', () => {
  it('requires Member authentication', async () => {
    const response = await app.handle(new Request('http://localhost/api/v1/wallet'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });
});
