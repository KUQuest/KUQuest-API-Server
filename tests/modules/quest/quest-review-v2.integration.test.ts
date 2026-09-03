import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const reviewId = '018f47a7-1c7d-7c98-9a11-690d7e834301';

const request = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe('Quest Review API v2 HTTP contract', () => {
  it.each([
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 5 }],
    ['PATCH', `/api/v2/quests/${questId}/reviews/${reviewId}`, { rating: 4 }],
  ] as Array<[string, string, unknown]>)('requires Idempotency-Key for %s Review commands', async (method, path, body) => {
    const response = await request(method, path, {}, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'The Idempotency-Key header is required' },
    });
  });

  it.each([
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 6 }],
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 5, comment: '   ' }],
    ['PATCH', `/api/v2/quests/${questId}/reviews/${reviewId}`, {}],
  ] as Array<[string, string, unknown]>)('validates %s Review input before authentication', async (method, path, body) => {
    const response = await request(method, path, { 'idempotency-key': 'review-v2-validation' }, body);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it.each([
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 5 }],
    ['PATCH', `/api/v2/quests/${questId}/reviews/${reviewId}`, { rating: 4 }],
  ] as Array<[string, string, unknown]>)('requires Member authentication for %s Review commands', async (method, path, body) => {
    const response = await request(method, path, { 'idempotency-key': `review-v2-auth-${method}` }, body);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('publishes the v2 create and edit operations without a v2 delete operation', async () => {
    const response = await request('GET', '/openapi/json');
    const document = await response.json() as {
      paths: Record<string, Record<string, {
        operationId?: string;
        parameters?: Array<Record<string, unknown>>;
        security?: unknown;
      }> | undefined>;
    };

    const create = document.paths['/api/v2/quests/{questId}/reviews']?.post;
    const update = document.paths['/api/v2/quests/{questId}/reviews/{reviewId}']?.patch;

    expect(create?.operationId).toBe('createQuestReviewV2');
    expect(update?.operationId).toBe('updateQuestReviewV2');
    expect(create?.security).toEqual([{ betterAuthSession: [] }]);
    expect(update?.security).toEqual([{ betterAuthSession: [] }]);
    expect(create?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
    ]));
    expect(update?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
    ]));
    expect(document.paths['/api/v2/quests/{questId}/reviews']?.delete).toBeUndefined();
    expect(document.paths['/api/v2/quests/{questId}/reviews/{reviewId}']?.delete).toBeUndefined();
  });
});
