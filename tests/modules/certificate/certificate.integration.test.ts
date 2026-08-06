import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

const certificatesUrl = 'http://localhost/api/v1/profile/certificates';
const certificateId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

const validBody = {
  name: 'AWS Certified Cloud Practitioner',
  issuer: 'Amazon Web Services',
  issuedAt: '2024-05-01',
};

const json = (method: string, url: string, body: unknown) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const unauthorized = {
  success: false,
  error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
};

describe('certificate integration — authentication', () => {
  it('rejects an unauthenticated collection read', async () => {
    const response = await app.handle(new Request(certificatesUrl));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });

  it('rejects an unauthenticated single-record read', async () => {
    const response = await app.handle(new Request(`${certificatesUrl}/${certificateId}`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });

  it('rejects an unauthenticated create', async () => {
    const response = await app.handle(json('POST', certificatesUrl, validBody));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });

  it('rejects an unauthenticated update', async () => {
    const response = await app.handle(
      json('PATCH', `${certificatesUrl}/${certificateId}`, { name: 'Renamed' }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });

  it('rejects an unauthenticated delete', async () => {
    const response = await app.handle(
      new Request(`${certificatesUrl}/${certificateId}`, { method: 'DELETE' }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(unauthorized);
  });
});

describe('certificate integration — validation', () => {
  // Elysia validates body and params before the guard's onBeforeHandle runs (ADR
  // 0003), so these reach the validation rules without an authenticated Session.
  const expectValidationError = async (request: Request) => {
    const response = await app.handle(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION');
  };

  it('rejects a create missing required fields', async () => {
    await expectValidationError(json('POST', certificatesUrl, { name: 'Only a name' }));
  });

  it('rejects an empty name', async () => {
    await expectValidationError(json('POST', certificatesUrl, { ...validBody, name: '' }));
  });

  it('rejects an empty issuer', async () => {
    await expectValidationError(json('POST', certificatesUrl, { ...validBody, issuer: '' }));
  });

  it('rejects a malformed issuedAt', async () => {
    await expectValidationError(
      json('POST', certificatesUrl, { ...validBody, issuedAt: 'last tuesday' }),
    );
  });

  it('rejects a malformed verifyUrl', async () => {
    await expectValidationError(
      json('POST', certificatesUrl, { ...validBody, verifyUrl: 'not a url' }),
    );
  });

  it('rejects a malformed verifyUrl on update', async () => {
    await expectValidationError(
      json('PATCH', `${certificatesUrl}/${certificateId}`, { verifyUrl: 'not a url' }),
    );
  });

  it('rejects a non-uuid certificate id on read', async () => {
    await expectValidationError(new Request(`${certificatesUrl}/not-a-uuid`));
  });

  it('rejects a non-uuid certificate id on update', async () => {
    await expectValidationError(json('PATCH', `${certificatesUrl}/not-a-uuid`, { name: 'x' }));
  });

  it('rejects a non-uuid certificate id on delete', async () => {
    await expectValidationError(
      new Request(`${certificatesUrl}/not-a-uuid`, { method: 'DELETE' }),
    );
  });

  it('rejects an unknown field on create', async () => {
    await expectValidationError(json('POST', certificatesUrl, { ...validBody, bogus: 'x' }));
  });

  it('rejects an unknown field on update', async () => {
    await expectValidationError(
      json('PATCH', `${certificatesUrl}/${certificateId}`, { name: 'Renamed', bogus: 'x' }),
    );
  });
});
