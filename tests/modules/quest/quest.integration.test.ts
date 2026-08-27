import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

describe('Quest integration', () => {
  it.each([
    ['GET', '/api/v1/quests'],
    ['GET', '/api/v1/quests/mine'],
    ['GET', '/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c'],
    ['POST', '/api/v1/quests'],
    ['PATCH', '/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c'],
  ])('%s %s requires Member authentication', async (method, path) => {
    const hasBody = method === 'POST' || method === 'PATCH';
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body:
          method === 'POST'
            ? JSON.stringify({})
            : hasBody
              ? JSON.stringify({ title: 'Edit' })
              : undefined,
      }),
    );

    expect(response.status).toBe(method === 'POST' ? 400 : 401);
    expect((await response.json()).success).toBe(false);
  });

  it('requires Member authentication before accepting Quest Images', async () => {
    const form = new FormData();
    form.set('images', new File(['not-an-image'], 'quest.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request(
        'http://localhost/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/images',
        { method: 'POST', body: form },
      ),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('requires Member authentication to delete a Quest Image', async () => {
    const response = await app.handle(
      new Request(
        'http://localhost/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/images/018f47a7-1c7d-7c98-9a11-690d7e834301',
        { method: 'DELETE' },
      ),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
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

  it('rejects unknown Quest edit fields before authentication', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Edit', unknown: true }),
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
    expect(document.paths['/api/v1/quests/{questId}']?.patch?.operationId).toBe('editQuest');
    expect(document.paths['/api/v1/quests/{questId}']?.patch?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v1/quests']?.get?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v1/quests/{questId}/publish-check']?.get?.operationId).toBe(
      'getQuestPublishCheck',
    );
    expect(document.paths['/api/v1/quests/{questId}/publish-check']?.get?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v1/quests/{questId}/publish']?.post?.operationId).toBe(
      'publishQuest',
    );
    expect(document.paths['/api/v1/quests/{questId}/publish']?.post?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v1/quests/{questId}/images']?.post?.operationId).toBe(
      'addQuestImages',
    );
    expect(document.paths['/api/v1/quests/{questId}/images']?.post?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(
      document.paths['/api/v1/quests/{questId}/images/{imageId}']?.delete?.operationId,
    ).toBe('deleteQuestImage');
    expect(
      document.paths['/api/v1/quests/{questId}/images/{imageId}']?.delete?.security,
    ).toEqual([{ betterAuthSession: [] }]);
  });

  it('documents Quest Image upload as multipart with the images field', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, {
        requestBody?: { content?: Record<string, unknown> };
      }>>;
    };
    const operation = document.paths['/api/v1/quests/{questId}/images']?.post;

    expect(operation?.requestBody?.content?.['multipart/form-data']).toBeDefined();
  });

  it('rejects more than three Quest Images before authentication runs', async () => {
    const form = new FormData();
    for (const name of ['one.png', 'two.png', 'three.png', 'four.png']) {
      form.append('images', new File(['not-an-image'], name, { type: 'image/png' }));
    }

    const response = await app.handle(
      new Request(
        'http://localhost/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/images',
        { method: 'POST', body: form },
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it.each([
    ['GET', '/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/publish-check'],
    ['POST', '/api/v1/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/publish'],
  ])('%s %s requires Member authentication', async (method, path) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, { method }),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });
});
