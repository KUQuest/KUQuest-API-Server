import { adminAuth } from '@/modules/auth/admin-auth.config';

import { describe, expect, it } from 'bun:test';

describe('Admin authentication configuration', () => {
  it('enables credential login without public signup', () => {
    expect(adminAuth.options.basePath).toBe('/api/admin/auth');
    expect(adminAuth.options.emailAndPassword).toMatchObject({
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
      maxPasswordLength: 25,
    });
  });

  it('disables Better Auth rate limiting for the Admin instance', () => {
    expect(adminAuth.options.rateLimit).toMatchObject({ enabled: false });
  });

  it('uses the Admin identity tables and isolated cookie prefix', () => {
    expect(adminAuth.options.user?.modelName).toBe('authAdmin');
    expect(adminAuth.options.session?.modelName).toBe('authSession');
    expect(adminAuth.options.session?.fields?.userId).toBe('adminId');
    expect(adminAuth.options.account?.modelName).toBe('authAccount');
    expect(adminAuth.options.account?.fields?.userId).toBe('adminId');
    expect(adminAuth.options.advanced?.cookiePrefix).toBe('kuquest-admin');
  });
});
