import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

describe('academic registration integration', () => {
  it('returns the shared error shape for an unauthenticated options request', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/academic-registration/options'),
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
      new Request('http://localhost/api/v1/academic-registration/status'),
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
      new Request('http://localhost/api/v1/academic-registration', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telephone: '0800000000' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('rejects an empty update body', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/academic-registration', {
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

  it('rejects a null field value', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/academic-registration', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telephone: null }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
  });

  it('rejects a malformed telephone number', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/academic-registration', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telephone: '123' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
  });

  it('rejects a non-10-digit student ID', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/academic-registration', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studentId: '123' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
  });

  it('rejects an unknown field', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/academic-registration', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nickname: 'nope' }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
  });
});
