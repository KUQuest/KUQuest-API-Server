import { app } from '@/app';
import { ALLOWED_EMAIL_DOMAIN, auth } from '@/modules/auth';

import { describe, expect, it } from 'bun:test';

describe('authentication integration', () => {
  it('serves the browser Quest and finance test bench', async () => {
    const response = await app.handle(new Request('http://localhost/'));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('KUQuest API Test Bench');
    expect(body).toContain('/api/auth/sign-in/social');
    expect(body).toContain('/api/staging/test-auth/sign-in/default');
    expect(body).toContain('/api/v1/wallet');
    expect(body).not.toContain('/api/local/test/wallet');
    expect(body).toContain('/api/local/test/payment');
    expect(body).toContain('Payment QR from Xendit');
    expect(body).toContain('Top-up credit (Baht)');
    expect(body).toContain('Receipt amount (Baht)');
    expect(body).not.toContain('Top-up credit (Satang)');
    expect(body).toContain('/api/v1/quests');
    expect(body).toContain('Run simple Quest flow');
    expect(body).toContain('/api/v1/payouts/quotes');
    expect(body).toContain('All implemented Quest API operations');
    expect(body).toContain('Debug messages');
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

  it('rejects an unverifiable native ID token', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          idToken: { token: 'not-a-real-google-id-token' },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe('INVALID_TOKEN');
    expect(body.code).not.toBe('EMAIL_DOMAIN_NOT_ALLOWED');
  });

  it.each([
    ['GET', '/api/auth/list-sessions'],
    ['POST', '/api/auth/revoke-session'],
    ['POST', '/api/auth/revoke-sessions'],
    ['POST', '/api/auth/revoke-other-sessions'],
  ])('rejects an unauthenticated %s %s', async (method, path) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ token: 'x' }) : undefined,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.code).toBe('UNAUTHORIZED');
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

  it.each([
    '/api/auth/sign-up/email',
    '/api/auth/change-password',
    '/api/auth/request-password-reset',
    '/api/auth/reset-password',
  ])('does not expose Student %s', async (path) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, { method: 'POST' }),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    ['POST', '/api/auth/sign-in/social'],
    ['GET', '/api/auth/callback/google'],
    ['GET', '/api/auth/get-session'],
    ['GET', '/api/auth/list-sessions'],
    ['POST', '/api/auth/revoke-session'],
    ['POST', '/api/auth/revoke-sessions'],
    ['POST', '/api/auth/revoke-other-sessions'],
    ['POST', '/api/auth/sign-out'],
  ])('still exposes allow-listed Student %s %s', async (method, path) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      }),
    );

    expect(response.status).not.toBe(404);
  });
});
