import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('profile avatar integration', () => {
  it('requires authentication before accepting an avatar', async () => {
    const form = new FormData();
    form.set(
      'avatar',
      new File(['not-an-image'], 'avatar.png', { type: 'image/png' }),
    );

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

  it('documents the authenticated multipart avatar endpoint', async () => {
    const response = await app.handle(
      new Request('http://localhost/openapi/json'),
    );
    const document = await response.json() as {
      paths?: Record<string, Record<string, {
        requestBody?: {
          content?: Record<string, unknown>;
        };
        security?: Array<Record<string, unknown>>;
      }>>;
    };
    const operation = document.paths?.['/api/v1/profile/avatar']?.post;

    expect(operation).toBeDefined();
    expect(operation?.requestBody?.content?.['multipart/form-data']).toBeDefined();
    expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
  });
});
