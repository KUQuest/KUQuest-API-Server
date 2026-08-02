import { app } from '@/app';
import { ALLOWED_EMAIL_DOMAIN, auth } from '@/modules/auth';

import { describe, expect, it } from 'bun:test';

describe('authentication integration', () => {
  it('serves the browser authentication test page', async () => {
    const response = await app.handle(new Request('http://localhost/'));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('KUQuest Auth Test');
    expect(body).toContain('/api/auth/sign-in/social');
    expect(body).toContain('/api/v1/profile/avatar');
    expect(body).toContain('upload-status');
    expect(body).toContain('[avatar-upload] Response received');
    expect(body).toContain("window.location.protocol === 'file:'");
    expect(body).toContain('http://localhost:5000');
  });

  it('enables only Google sign-in', () => {
    expect(auth.options.emailAndPassword?.enabled).toBe(false);
    expect(Object.keys(auth.options.socialProviders ?? {})).toEqual(['google']);
    expect(auth.options.socialProviders?.google?.hd).toBe(ALLOWED_EMAIL_DOMAIN);
  });

  it('returns no session for an unauthenticated request', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/get-session'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it('routes the Admin session endpoint to the Admin Better Auth instance', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/admin/auth/get-session'),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it.each([
    '/api/admin/auth/sign-up/email',
    '/api/admin/auth/change-password',
    '/api/admin/auth/request-password-reset',
    '/api/admin/auth/reset-password',
  ])('does not expose Admin %s', async (path) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, { method: 'POST' }),
    );

    expect(response.status).toBe(404);
  });
});
