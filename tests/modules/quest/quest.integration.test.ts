import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('Quest integration', () => {
  it.each([
    ['GET', '/api/v1/quests'],
    ['GET', '/api/v1/quests/mine'],
    ['GET', '/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c'],
    ['POST', '/api/v1/quests'],
  ])('%s %s requires Member authentication', async (method, path) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify({}) : undefined,
      }),
    );

    expect(response.status).toBe(method === 'POST' ? 400 : 401);
    expect((await response.json()).success).toBe(false);
  });

  it('rejects unknown create fields before authentication', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/quests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ unknown: true }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('publishes all Quest operations with Member security', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };

    expect(document.paths['/api/v1/quests']?.post?.operationId).toBe('createQuest');
    expect(document.paths['/api/v1/quests']?.get?.operationId).toBe('listQuestBoard');
    expect(document.paths['/api/v1/quests/mine']?.get?.operationId).toBe('listOwnQuests');
    expect(document.paths['/api/v1/quests/{questId}']?.get?.operationId).toBe('getQuestDetail');
    expect(document.paths['/api/v1/quests']?.get?.security).toEqual([
      { betterAuthSession: [] },
    ]);
  });
});
