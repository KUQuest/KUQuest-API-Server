import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const createBody = {
  title: 'Design a poster',
  condition: { items: ['Use the KUQuest brand', 'Return an editable file'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20.0,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000Z',
};

type OpenApiSchema = {
  multipleOf?: number;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
};

type OpenApiOperation = {
  operationId?: string;
  security?: unknown;
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
};

describe('Quest API v2 integration', () => {
  it('validates the required Idempotency-Key before authentication', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v2/quests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createBody),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('rejects legacy Quest vocabulary before authentication', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v2/quests', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'v2-contract-test',
        },
        body: JSON.stringify({
          ...createBody,
          mode: 'NO_CANDIDATE',
          participation: 'SOLO',
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it.each([
    ['GET', '/api/v2/quests/mine'],
    ['GET', '/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c'],
    ['POST', '/api/v2/quests'],
  ])('%s %s requires Member authentication', async (method, path) => {
    const response = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers:
          method === 'POST'
            ? {
                'content-type': 'application/json',
                'idempotency-key': 'v2-auth-test',
              }
            : undefined,
        body: method === 'POST' ? JSON.stringify(createBody) : undefined,
      }),
    );

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('documents the v2 Draft foundation with the v2 paths and security', async () => {
    const response = await app.handle(new Request('http://localhost/openapi/json'));
    const document = (await response.json()) as {
      paths: Record<string, Record<string, OpenApiOperation>>;
    };

    expect(document.paths['/api/v2/quests']?.post?.operationId).toBe('createQuestV2');
    expect(document.paths['/api/v2/quests/mine']?.get?.operationId).toBe('listOwnQuestsV2');
    expect(document.paths['/api/v2/quests/{questId}']?.get?.operationId).toBe(
      'getQuestV2Detail',
    );
    expect(document.paths['/api/v2/quests']?.post?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v2/quests/mine']?.get?.security).toEqual([
      { betterAuthSession: [] },
    ]);

    const bodySchema =
      document.paths['/api/v2/quests']?.post?.requestBody?.content?.['application/json']?.schema;
    expect(bodySchema?.properties?.questFundingTotal?.multipleOf).toBe(0.01);
    expect(bodySchema?.properties?.locations?.items?.required).toEqual(['label']);
    expect(bodySchema?.properties?.locations?.items?.properties?.label?.nullable).not.toBe(true);
  });
});
