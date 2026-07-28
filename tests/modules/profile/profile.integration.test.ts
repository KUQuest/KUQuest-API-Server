import { app } from '@/app';

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

const patchProfile = (body: unknown) =>
  app.handle(
    new Request('http://localhost/api/v1/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

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

  it('rejects an unauthenticated update', async () => {
    const response = await patchProfile({ bio: 'hello' });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('requires authentication before accepting an avatar', async () => {
    const form = new FormData();
    form.set('avatar', new File(['not-an-image'], 'avatar.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request('http://localhost/api/v1/profile/avatar', {
        method: 'POST',
        body: form,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  // Elysia validates the body before the auth guard runs, so every rejected-input
  // case below is reachable without a session.
  describe('rejected input', () => {
    const cases: Array<[string, unknown]> = [
      ['a telephone carrying separators', { telephone: '080-000-0000' }],
      ['a telephone that is too short', { telephone: '12345' }],
      ['a telephone not starting with zero', { telephone: '1800000000' }],
      ['a bio cleared with null', { bio: null }],
      ['a telephone cleared with null', { telephone: null }],
      ['a major cleared with null', { majorId: null }],
      ['an empty first name', { firstName: '' }],
      ['a whitespace-only first name', { firstName: '   ' }],
      ['an empty last name', { lastName: '' }],
      ['a whitespace-only last name', { lastName: '   ' }],
      ['a bio cleared with an empty string', { bio: '' }],
      ['a bio cleared with whitespace', { bio: '   ' }],
      ['a telephone cleared with an empty string', { telephone: '' }],
      ['a major cleared with an empty string', { majorId: '' }],
      ['a bio beyond the maximum length', { bio: 'a'.repeat(501) }],
      ['a major that is not a uuid', { majorId: 'not-a-uuid' }],
      ['a first name beyond the maximum length', { firstName: 'a'.repeat(101) }],
      ['a last name beyond the maximum length', { lastName: 'a'.repeat(101) }],
      ['a student id, which this endpoint does not own', { studentId: '6500000001' }],
      ['an academic year, which this endpoint does not own', { academicYear: 2026 }],
      ['an email, which this endpoint does not own', { email: 'other@ku.th' }],
      ['a verified flag, which this endpoint does not own', { emailVerified: true }],
      ['an avatar, which the avatar endpoint owns', { imageFileId: randomUUID() }],
      ['a legacy image field, which this endpoint does not own', { image: 'http://example.com' }],
      ['another student id smuggled alongside a valid field', { bio: 'x', id: 'someone-else' }],
      ['a first name of the wrong type', { firstName: 123 }],
      ['a property named with the empty string', { '': 'x' }],
    ];

    for (const [description, body] of cases) {
      it(`rejects ${description}`, async () => {
        const response = await patchProfile(body);

        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('VALIDATION');
      });
    }
  });

  it('treats a body it cannot parse as a client mistake, not a server fault', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'PARSE', message: 'Malformed request body' },
    });
  });

  it('refuses a body it cannot read as an object', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'text/plain' },
        body: 'hello',
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('accepts a bio at exactly the maximum length', async () => {
    // Reaching the auth guard proves validation passed.
    const response = await patchProfile({ bio: 'a'.repeat(500) });

    expect(response.status).toBe(401);
  });

  describe('published documentation', () => {
    const openapiDocument = async () =>
      (await (await app.handle(new Request('http://localhost/openapi/json'))).json()) as {
        paths: Record<
          string,
          Record<
            string,
            {
              requestBody?: { content?: Record<string, unknown> };
              security?: Array<Record<string, unknown>>;
            }
          >
        >;
      };

    it('publishes the read and update operations without a trailing slash', async () => {
      const document = await openapiDocument();

      expect(Object.keys(document.paths)).toContain('/api/v1/profile');
      expect(Object.keys(document.paths)).not.toContain('/api/v1/profile/');
    });

    it('marks every profile operation as requiring authentication', async () => {
      const document = await openapiDocument();
      const profilePath = document.paths['/api/v1/profile'];
      const avatarOperation = document.paths['/api/v1/profile/avatar']?.post;

      expect(profilePath?.get?.security).toEqual([{ betterAuthSession: [] }]);
      expect(profilePath?.patch?.security).toEqual([{ betterAuthSession: [] }]);
      expect(avatarOperation?.security).toEqual([{ betterAuthSession: [] }]);
    });

    it('documents the avatar endpoint as multipart', async () => {
      const document = await openapiDocument();
      const operation = document.paths['/api/v1/profile/avatar']?.post;

      expect(operation).toBeDefined();
      expect(operation?.requestBody?.content?.['multipart/form-data']).toBeDefined();
    });
  });
});
