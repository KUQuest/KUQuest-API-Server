import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

describe('profile integration', () => {
  it('rejects an unauthenticated read', async () => {
    const response = await app.handle(new Request('http://localhost/api/v1/profile'));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });
});
