import { describe, expect, it } from 'bun:test';

import { app } from '@/app';
import { ALLOWED_EMAIL_DOMAIN, auth } from '@/modules/auth';

describe('authentication integration', () => {
  it('serves the browser authentication test page', async () => {
    const response = await app.handle(new Request('http://localhost/'));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(body).toContain('KUQuest — ทดสอบการไหลของเงิน');
    expect(body).toContain('เข้าสู่ระบบด้วย Google');
    expect(body).toContain('/app.js');
    expect(body).toContain('รายละเอียด API');
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
});
