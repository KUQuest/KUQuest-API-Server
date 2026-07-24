import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

describe('onboarding integration', () => {
  it('returns the shared error shape for an unauthenticated status request', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/status'),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('returns the shared error shape for an unauthenticated update request', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/update', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          telephone: '080-000-0000',
          faculty: 'Engineering',
          studentId: '6500000000',
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('returns the shared error shape for an unauthenticated get-data request', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/get-data'),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });
});
