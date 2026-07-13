import { describe, expect, it } from 'bun:test';

import { isAllowedEmail } from '@/modules/auth';

describe('auth email policy', () => {
  it('allows only email addresses in the ku.th domain', () => {
    expect(isAllowedEmail('student@ku.th')).toBe(true);
    expect(isAllowedEmail('STUDENT@KU.TH')).toBe(true);
    expect(isAllowedEmail('student@gmail.com')).toBe(false);
    expect(isAllowedEmail('student@sub.ku.th')).toBe(false);
    expect(isAllowedEmail('student@notku.th')).toBe(false);
    expect(isAllowedEmail(undefined)).toBe(false);
  });
});
