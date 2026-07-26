import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

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
      ['a student id, which this endpoint does not own', { studentId: '6500000001' }],
      ['an academic year, which this endpoint does not own', { academicYear: 2026 }],
      ['an email, which this endpoint does not own', { email: 'other@ku.th' }],
      ['another student id smuggled alongside a valid field', { bio: 'x', id: 'someone-else' }],
      ['a first name of the wrong type', { firstName: 123 }],
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

  it('publishes both operations without a trailing slash', async () => {
    const document = await (
      await app.handle(new Request('http://localhost/openapi/json'))
    ).json();

    expect(Object.keys(document.paths)).toContain('/api/v1/profile');
    expect(Object.keys(document.paths)).not.toContain('/api/v1/profile/');
  });

  it('accepts a bio at exactly the maximum length', async () => {
    // Reaching the auth guard proves validation passed.
    const response = await patchProfile({ bio: 'a'.repeat(500) });

    expect(response.status).toBe(401);
  });
});
