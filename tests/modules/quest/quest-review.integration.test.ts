import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const reviewId = '018f47a7-1c7d-7c98-9a11-690d7e834301';

const request = (method: string, path: string, body?: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe('Quest Review HTTP contract', () => {
  it.each([
    ['POST', `/api/v1/quests/${questId}/reviews`, { revieweeId: 'not-a-uuid', rating: 6 }],
    ['PATCH', `/api/v1/quests/${questId}/reviews/${reviewId}`, { rating: 0 }],
    ['POST', `/api/v1/quests/${questId}/reviews`, { revieweeId: reviewId, rating: 5, extra: true }],
  ] as Array<[string, string, unknown]>)('returns the shared validation envelope for invalid %s input', async (method, path, body) => {
    const response = await request(method, path, body);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it.each([
    ['POST', `/api/v1/quests/${questId}/reviews`, { revieweeId: reviewId, rating: 5 }],
    ['PATCH', `/api/v1/quests/${questId}/reviews/${reviewId}`, { rating: 4 }],
    ['DELETE', `/api/v1/quests/${questId}/reviews/${reviewId}`, undefined],
  ] as Array<[string, string, unknown]>)('requires Member authentication for %s Review mutations', async (method, path, body) => {
    const response = await request(method, path, body);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('publishes the Review create, edit, and no-delete operations', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = await response.json();
    expect(document.paths[`/api/v1/quests/{questId}/reviews`]?.post?.operationId).toBe('createQuestReview');
    expect(document.paths[`/api/v1/quests/{questId}/reviews/{reviewId}`]?.patch?.operationId).toBe('updateQuestReview');
    expect(document.paths[`/api/v1/quests/{questId}/reviews/{reviewId}`]?.delete?.operationId).toBe('deleteQuestReview');
  });
});
