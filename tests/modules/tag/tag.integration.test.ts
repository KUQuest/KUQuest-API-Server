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

  it('publishes the Tag collection with Member security, query params, and responses', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            security?: unknown;
            parameters?: Array<{ name: string; in: string }>;
            responses?: Record<string, { content?: unknown }>;
          }
        >
      >;
    };
    const collection = document.paths['/api/v1/tags'];

    expect(collection?.get?.operationId).toBe('listTags');
    expect(collection?.get?.security).toEqual([{ betterAuthSession: [] }]);
    expect(collection?.get?.responses?.['200']?.content).toBeDefined();
    expect(collection?.get?.responses?.['400']?.content).toBeDefined();
    expect(collection?.get?.responses?.['401']?.content).toBeDefined();

    const paramNames = collection?.get?.parameters?.map((p) => p.name) ?? [];
    expect(paramNames).toContain('q');
    expect(paramNames).toContain('limit');
    expect(paramNames).toContain('cursor');
  });

  it('rejects an invalid limit outside 1..50 before authentication runs', async () => {
    const response = await app.handle(new Request('http://localhost/api/v1/tags?limit=999'));
    expect(response.status).toBe(400);

    const negativeResponse = await app.handle(new Request('http://localhost/api/v1/tags?limit=0'));
    expect(negativeResponse.status).toBe(400);
  });

  it('rejects a query search string exceeding 100 characters before authentication runs', async () => {
    const longQuery = 'a'.repeat(101);
    const response = await app.handle(new Request(`http://localhost/api/v1/tags?q=${longQuery}`));
    expect(response.status).toBe(400);
  });
});
