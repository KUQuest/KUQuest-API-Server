import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

describe('onboarding integration', () => {
  it('returns the shared error shape for an unauthenticated academic options request', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/academic-options'),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

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
          departmentId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
          studentId: '6500000000',
          academicYear: 2026,
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

  it('rejects an empty onboarding update', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/update', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
  });

  it('rejects null onboarding values', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/update', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ academicYear: null }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
  });

  it('accepts a four-digit Gregorian academic year', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/update', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ academicYear: 2026 }),
      }),
    );

    expect(response.status).toBe(401);
  });

  it('rejects academic years outside the four-digit range', async () => {
    const cases = await Promise.all(
      [999, 10000].map(async (academicYear) => {
        const validationResponse = await app.handle(
          new Request('http://localhost/api/v1/onboarding/update', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ academicYear }),
          }),
        );

        return { body: await validationResponse.json(), validationResponse };
      }),
    );

    for (const { body, validationResponse } of cases) {
      expect(validationResponse.status).toBe(400);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('VALIDATION');
    }
  });

  it('rejects a string Gregorian academic year', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/onboarding/update', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ academicYear: '2026' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
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
