import { isValidAdminPassword } from '@/modules/auth/admin-auth.policy';

import { describe, expect, it } from 'bun:test';

describe('Admin password policy', () => {
  it('accepts a password with all required character classes', () => {
    expect(isValidAdminPassword('AdminPass1!')).toBe(true);
  });

  it('rejects passwords shorter than eight characters', () => {
    expect(isValidAdminPassword('Aa1!abc')).toBe(false);
  });

  it('rejects passwords longer than twenty-five characters', () => {
    expect(isValidAdminPassword('AdminPasswordThatIsTooLong1!')).toBe(false);
  });

  it.each([
    ['missing uppercase', 'adminpass1!'],
    ['missing lowercase', 'ADMINPASS1!'],
    ['missing number', 'AdminPass!!'],
    ['missing special character', 'AdminPass11'],
    ['contains whitespace', 'Admin Pass1!'],
    ['contains a non-ASCII character', 'AdminPass1é'],
  ])('rejects a password that is %s', (_reason, password) => {
    expect(isValidAdminPassword(password)).toBe(false);
  });
});
