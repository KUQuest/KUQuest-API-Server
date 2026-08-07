import { describe, expect, it } from 'bun:test';

import { apiError, apiSuccess } from '@/shared/api-response';

describe('apiSuccess', () => {
  it('wraps data in a success envelope', () => {
    expect(apiSuccess({ completed: true })).toEqual({
      success: true,
      data: { completed: true },
    });
  });

  it('omits data when called with no argument', () => {
    expect(apiSuccess()).toEqual({ success: true });
  });
});

describe('apiError', () => {
  it('wraps a code and message in an error envelope', () => {
    expect(apiError('UNAUTHORIZED', 'Unauthorized')).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });
});
