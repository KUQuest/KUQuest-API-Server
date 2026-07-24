import { describe, expect, it } from 'bun:test';
import { Elysia, t } from 'elysia';

import { errorHandlerPlugin } from '@/plugins/error-handler';

describe('errorHandlerPlugin', () => {
  it('catches an unhandled throw in a sibling plugin and returns the shared error shape', async () => {
    const noisyPlugin = new Elysia({ name: 'noisy' }).get('/boom', () => {
      throw new Error('kaboom');
    });

    const app = new Elysia().use(errorHandlerPlugin).use(noisyPlugin);

    const res = await app.handle(new Request('http://localhost/boom'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNKNOWN', message: 'Internal server error' },
    });
  });

  it('maps a VALIDATION error to status 400', async () => {
    const validatedPlugin = new Elysia({ name: 'validated' }).get(
      '/validate',
      ({ query }) => query.required,
      { query: t.Object({ required: t.String() }) },
    );

    const app = new Elysia().use(errorHandlerPlugin).use(validatedPlugin);

    const res = await app.handle(new Request('http://localhost/validate'));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: { code: 'VALIDATION', message: expect.any(String) },
    });
  });
});
