import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('Tag integration', () => {
  it('requires Member authentication', async () => {
    const response = await app.handle(new Request('http://localhost/api/v1/tags'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('publishes the Tag collection with Member security', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            security?: unknown;
            responses?: Record<string, { content?: unknown }>;
          }
        >
      >;
    };
    const collection = document.paths['/api/v1/tags'];

    expect(collection?.get?.operationId).toBe('listTags');
    expect(collection?.get?.security).toEqual([{ betterAuthSession: [] }]);
    expect(collection?.get?.responses?.['200']?.content).toBeDefined();
    expect(collection?.get?.responses?.['401']?.content).toBeDefined();
  });
});
