import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const reviewId = '018f47a7-1c7d-7c98-9a11-690d7e834301';

const request = (
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

describe('Quest Review API v2 HTTP contract', () => {
  it.each([
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 5 }],
    ['PATCH', `/api/v2/quests/${questId}/reviews/${reviewId}`, { rating: 4 }],
  ] as Array<[string, string, unknown]>)(
    'requires Idempotency-Key for %s Review commands',
    async (method, path, body) => {
      const response = await request(method, path, {}, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'The Idempotency-Key header is required',
        },
      });
    }
  );

  it.each([
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 6 }],
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 5, comment: '   ' }],
    ['PATCH', `/api/v2/quests/${questId}/reviews/${reviewId}`, {}],
  ] as Array<[string, string, unknown]>)(
    'validates %s Review input before authentication',
    async (method, path, body) => {
      const response = await request(
        method,
        path,
        { 'idempotency-key': 'review-v2-validation' },
        body
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION');
    }
  );

  it.each([
    ['GET', `/api/v2/quests/${questId}/reviews`],
    ['GET', `/api/v2/quests/${questId}/reviews/${reviewId}`],
  ])('requires Member authentication for %s Review reads', async (method, path) => {
    const response = await request(method, path);

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it.each([`/api/v2/quests/not-a-uuid/reviews`, `/api/v2/quests/${questId}/reviews/not-a-uuid`])(
    'validates Review read parameters before authentication',
    async (path) => {
      const response = await request('GET', path);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION');
    }
  );

  it.each([
    ['POST', `/api/v2/quests/${questId}/reviews`, { rating: 5 }],
    ['PATCH', `/api/v2/quests/${questId}/reviews/${reviewId}`, { rating: 4 }],
  ] as Array<[string, string, unknown]>)(
    'requires Member authentication for %s Review commands',
    async (method, path, body) => {
      const response = await request(
        method,
        path,
        { 'idempotency-key': `review-v2-auth-${method}` },
        body
      );

      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('UNAUTHORIZED');
    }
  );

  it('publishes authenticated v2 Review read operations and no delete operation', async () => {
    const response = await request('GET', '/openapi/json');
    const document = (await response.json()) as {
      paths: Record<
        string,
        | Record<
            string,
            {
              operationId?: string;
              parameters?: Array<Record<string, unknown>>;
              security?: unknown;
              responses?: Record<string, unknown>;
            }
          >
        | undefined
      >;
    };

    const create = document.paths['/api/v2/quests/{questId}/reviews']?.post;
    const update = document.paths['/api/v2/quests/{questId}/reviews/{reviewId}']?.patch;
    const list = document.paths['/api/v2/quests/{questId}/reviews']?.get;
    const detail = document.paths['/api/v2/quests/{questId}/reviews/{reviewId}']?.get;

    expect(create?.operationId).toBe('createQuestReviewV2');
    expect(update?.operationId).toBe('updateQuestReviewV2');
    expect(list?.operationId).toBe('listQuestReviewsV2');
    expect(detail?.operationId).toBe('getQuestReviewV2');
    expect(list?.security).toEqual([{ betterAuthSession: [] }]);
    expect(detail?.security).toEqual([{ betterAuthSession: [] }]);
    expect(create?.security).toEqual([{ betterAuthSession: [] }]);
    expect(update?.security).toEqual([{ betterAuthSession: [] }]);
    expect(list?.responses).toHaveProperty('200');
    expect(list?.responses).toHaveProperty('404');
    expect(detail?.responses).toHaveProperty('200');
    expect(detail?.responses).toHaveProperty('404');
    expect(create?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
      ])
    );
    expect(update?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'idempotency-key', in: 'header', required: true }),
      ])
    );
    expect(document.paths['/api/v2/quests/{questId}/reviews']?.delete).toBeUndefined();
    expect(document.paths['/api/v2/quests/{questId}/reviews/{reviewId}']?.delete).toBeUndefined();
  });
});
