import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const createBody = {
  title: 'Design a poster',
  condition: { items: ['Use the KUQuest brand', 'Return an editable file'] },
  mode: 'FIRST_COME_FIRST_SERVED',
  participation: 'SINGLE',
  questFundingTotal: 20.0,
  headcount: 1,
  startTime: '2030-08-26T10:00:00.000+07:00',
};

type OpenApiSchema = {
  anyOf?: OpenApiSchema[];
  const?: unknown;
  description?: string;
  maximum?: number;
  minimum?: number;
  multipleOf?: number;
  pattern?: string;
  nullable?: boolean;
  required?: string[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
};

type OpenApiOperation = {
  operationId?: string;
  security?: unknown;
  parameters?: Array<{ name?: string; in?: string; required?: boolean; schema?: OpenApiSchema }>;
  requestBody?: {
    content?: Record<string, { schema?: OpenApiSchema }>;
  };
  responses?: Record<string, {
    content?: Record<string, { schema?: OpenApiSchema }>;
  }>;
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

  it('validates required PATCH headers before authentication', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Updated title' }),
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
    ['GET', '/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/publish-check'],
    ['POST', '/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c/publish'],
    ['GET', '/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c'],
    ['POST', '/api/v2/quests'],
    ['PATCH', '/api/v2/quests/018f47a7-1c7d-7c98-9a11-690d7e83430c'],
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
            : method === 'PATCH'
              ? {
                  'content-type': 'application/json',
                  'idempotency-key': 'v2-auth-test',
                  'if-match': '1',
                }
            : undefined,
        body:
          method === 'POST'
            ? JSON.stringify(createBody)
            : method === 'PATCH'
              ? JSON.stringify({ title: 'Updated title' })
              : undefined,
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
    expect(document.paths['/api/v2/quests/{questId}']?.patch?.operationId).toBe(
      'editQuestV2Draft',
    );
    expect(
      document.paths['/api/v2/quests/{questId}/publish-check']?.get?.operationId,
    ).toBe('getQuestV2PublishCheck');
    const publishOperation = document.paths['/api/v2/quests/{questId}/publish']?.post;
    expect(publishOperation?.operationId).toBe('publishQuestV2');
    expect(publishOperation?.security).toEqual([{ betterAuthSession: [] }]);
    expect(publishOperation?.requestBody).toBeUndefined();
    expect(publishOperation?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'idempotency-key',
        in: 'header',
        required: true,
      }),
    ]));
    expect(Object.keys(publishOperation?.responses ?? {})).toEqual(expect.arrayContaining([
      '200',
      '400',
      '401',
      '404',
      '409',
      '500',
      '503',
    ]));
    expect(document.paths['/api/v2/quests']?.post?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v2/quests/mine']?.get?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v2/quests/{questId}']?.patch?.security).toEqual([
      { betterAuthSession: [] },
    ]);
    expect(document.paths['/api/v2/quests/{questId}/publish-check']?.get?.security).toEqual([
      { betterAuthSession: [] },
    ]);

    const bodySchema =
      document.paths['/api/v2/quests']?.post?.requestBody?.content?.['application/json']?.schema;
    expect(bodySchema?.anyOf).toHaveLength(2);
    expect(bodySchema?.anyOf?.map((variant) => ({
      participation: variant.properties?.participation?.const,
      minimum: variant.properties?.headcount?.minimum,
      maximum: variant.properties?.headcount?.maximum,
    }))).toEqual(expect.arrayContaining([
      { participation: 'SINGLE', minimum: 1, maximum: 1 },
      { participation: 'GROUP', minimum: 2, maximum: 20 },
    ]));
    const requestScheduleTimePattern =
      '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?\\+07:00$';
    for (const variant of bodySchema?.anyOf ?? []) {
      expect(variant.properties?.startTime?.pattern).toBe(requestScheduleTimePattern);
      expect(variant.properties?.dueAt?.anyOf?.[0]?.pattern).toBe(requestScheduleTimePattern);
      expect(variant.properties?.questFundingTotal?.multipleOf).toBe(0.01);
      expect(variant.properties?.locations?.items?.required).toEqual(['label']);
      expect(variant.properties?.locations?.items?.properties?.label?.nullable).not.toBe(true);
    }

    const editBodySchema =
      document.paths['/api/v2/quests/{questId}']?.patch?.requestBody?.content?.['application/json']
        ?.schema;
    expect(editBodySchema?.anyOf).toHaveLength(3);
    const editSingleVariant = editBodySchema?.anyOf?.find(
      (variant) => variant.properties?.participation?.const === 'SINGLE',
    );
    expect(editSingleVariant?.properties?.headcount?.minimum).toBe(1);
    expect(editSingleVariant?.properties?.headcount?.maximum).toBe(1);
    const editGroupVariant = editBodySchema?.anyOf?.find(
      (variant) => variant.properties?.participation?.const === 'GROUP',
    );
    expect(editGroupVariant?.properties?.headcount?.minimum).toBe(2);
    expect(editGroupVariant?.properties?.headcount?.maximum).toBe(20);
    const editExistingParticipationVariant = editBodySchema?.anyOf?.find(
      (variant) => variant.properties?.participation === undefined,
    );
    expect(editExistingParticipationVariant?.properties?.headcount?.minimum).toBe(1);
    expect(editExistingParticipationVariant?.properties?.headcount?.maximum).toBe(20);
    for (const variant of editBodySchema?.anyOf ?? []) {
      expect(variant.properties?.startTime?.pattern).toBe(requestScheduleTimePattern);
      expect(variant.properties?.dueAt?.anyOf?.[0]?.pattern).toBe(requestScheduleTimePattern);
      expect(variant.properties?.questFundingTotal?.multipleOf).toBe(0.01);
    }

    const canonicalScheduleTimePattern =
      '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\+07:00$';
    const createResponseSchema =
      document.paths['/api/v2/quests']?.post?.responses?.['200']?.content
        ?.['application/json']?.schema;
    const createDataSchema = createResponseSchema?.properties?.data;
    expect(createDataSchema?.properties?.startTime?.pattern).toBe(canonicalScheduleTimePattern);
    expect(createDataSchema?.properties?.dueAt?.anyOf?.[0]?.pattern).toBe(
      canonicalScheduleTimePattern,
    );
    expect(createDataSchema?.properties?.questFundingTotal?.multipleOf).toBe(0.01);
    expect(createDataSchema?.properties?.createdAt?.pattern).toBeUndefined();

    const mineDataSchema =
      document.paths['/api/v2/quests/mine']?.get?.responses?.['200']?.content
        ?.['application/json']?.schema?.properties?.data;
    expect(mineDataSchema?.properties?.items?.items?.properties?.questFundingTotal?.multipleOf).toBe(
      0.01,
    );

    const editDataSchema =
      document.paths['/api/v2/quests/{questId}']?.patch?.responses?.['200']?.content
        ?.['application/json']?.schema?.properties?.data;
    expect(editDataSchema?.properties?.questFundingTotal?.multipleOf).toBe(0.01);

    const detailDataSchema =
      document.paths['/api/v2/quests/{questId}']?.get?.responses?.['200']?.content
        ?.['application/json']?.schema?.properties?.data;
    expect(detailDataSchema?.properties?.questFundingTotal?.multipleOf).toBe(0.01);

    const publishResponseSchema =
      document.paths['/api/v2/quests/{questId}/publish-check']?.get?.responses?.['200']?.content
        ?.['application/json']?.schema;
    expect(publishResponseSchema?.required).toEqual(['success', 'data']);
    const publishDataSchema = publishResponseSchema?.properties?.data;
    expect(publishDataSchema?.required).toEqual([
      'blockingReasons',
      'warnings',
      'canPublish',
      'questFundingTotal',
      'questFundingTotalSatang',
      'questReward',
      'questRewardSatang',
      'platformFee',
      'platformFeeSatang',
      'escrowRequirement',
      'escrowRequirementSatang',
      'headcount',
      'platformFeeBps',
      'feeRoundingMode',
      'policyRevisionId',
      'policyRevision',
    ]);
    for (const property of [
      'questFundingTotal',
      'questReward',
      'platformFee',
      'escrowRequirement',
    ]) {
      expect(publishDataSchema?.properties?.[property]?.multipleOf).toBe(0.01);
    }

    const publishCommandResponseSchema =
      publishOperation?.responses?.['200']?.content?.['application/json']?.schema;
    expect(publishCommandResponseSchema?.required).toEqual(['success', 'data']);
    const publishCommandDataSchema = publishCommandResponseSchema?.properties?.data;
    expect(publishCommandDataSchema?.required).toEqual(['quest', 'questEscrow']);
    expect(publishCommandDataSchema?.properties?.quest?.properties?.state).toBeDefined();
    expect(publishCommandDataSchema?.properties?.quest?.properties?.questFundingTotal?.multipleOf).toBe(
      0.01,
    );
    expect(publishCommandDataSchema?.properties?.questEscrow?.required).toEqual([
      'reservationId',
      'questFundingTotal',
      'questFundingTotalSatang',
      'questReward',
      'questRewardSatang',
      'platformFee',
      'platformFeeSatang',
      'escrowRequirement',
      'escrowRequirementSatang',
      'headcount',
      'platformFeeBps',
      'feeRoundingMode',
      'policyRevisionId',
      'policyRevision',
    ]);
    for (const property of [
      'questFundingTotal',
      'questReward',
      'platformFee',
      'escrowRequirement',
    ]) {
      expect(
        publishCommandDataSchema?.properties?.questEscrow?.properties?.[property]?.multipleOf,
      ).toBe(0.01);
    }
  });
});
