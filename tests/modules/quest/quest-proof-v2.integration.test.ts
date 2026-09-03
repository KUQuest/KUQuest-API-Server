import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const proofSubmissionId = '018f47a7-1c7d-7c98-9a11-690d7e834301';

const request = (
  method: string,
  path: string,
  headers: HeadersInit = {},
  body?: BodyInit,
) => app.handle(new Request(`http://localhost${path}`, { method, headers, body }));

describe('Quest Proof API v2 contract', () => {
  it('requires Idempotency-Key on every state-changing v2 Proof operation before authentication', async () => {
    const requests = [
      request('POST', `/api/v2/quests/${questId}/proof-submissions`, { 'content-type': 'application/json' }, JSON.stringify({ description: 'done' })),
      request('PATCH', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}`, { 'content-type': 'application/json' }, JSON.stringify({ description: 'updated' })),
      request('DELETE', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}`),
      request('POST', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/submit`),
      request('POST', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`, { 'content-type': 'application/json' }, JSON.stringify({ decision: 'PROOF_APPROVED' })),
      request('POST', `/api/v2/quests/${questId}/completion-confirmation`),
    ];
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(await Promise.all(responses.map(async (response) => (await response.json()).error.code))).toEqual([
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REQUIRED',
      'IDEMPOTENCY_KEY_REQUIRED',
    ]);
  });

  it('requires Member authentication for every v2 Proof operation', async () => {
    const headers = { 'content-type': 'application/json', 'idempotency-key': 'proof-v2-auth-test' };
    const requests = [
      request('POST', `/api/v2/quests/${questId}/proof-submissions`, headers, JSON.stringify({ description: 'done' })),
      request('PATCH', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}`, headers, JSON.stringify({ description: 'updated' })),
      request('DELETE', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}`, headers),
      request('POST', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/submit`, headers),
      request('POST', `/api/v2/quests/${questId}/proof-submissions/${proofSubmissionId}/review`, headers, JSON.stringify({ decision: 'PROOF_APPROVED' })),
      request('GET', `/api/v2/quests/${questId}/proof-submissions`),
      request('POST', `/api/v2/quests/${questId}/completion-confirmation`, headers),
    ];
    const responses = await Promise.all(requests);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401]);
  });

  it('documents all seven v2 operations with canonical Proof statuses and no retired vocabulary', async () => {
    const response = await request('GET', '/openapi/json');
    const document = await response.json() as {
      paths: Record<string, Record<string, {
        operationId?: string;
        security?: unknown;
        requestBody?: { content?: Record<string, { schema?: unknown }> };
        responses?: Record<string, unknown>;
      }>>;
    };
    const operations = [
      [
        '/api/v2/quests/{questId}/proof-submissions',
        'post',
        'createQuestV2ProofSubmission',
      ],
      [
        '/api/v2/quests/{questId}/proof-submissions',
        'get',
        'listQuestV2ProofSubmissions',
      ],
      [
        '/api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}',
        'patch',
        'editQuestV2ProofSubmission',
      ],
      [
        '/api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}',
        'delete',
        'deleteQuestV2ProofSubmission',
      ],
      [
        '/api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}/submit',
        'post',
        'submitQuestV2ProofSubmission',
      ],
      [
        '/api/v2/quests/{questId}/proof-submissions/{proofSubmissionId}/review',
        'post',
        'reviewQuestV2ProofSubmission',
      ],
      [
        '/api/v2/quests/{questId}/completion-confirmation',
        'post',
        'confirmQuestV2Completion',
      ],
    ] as const;

    for (const [path, method, operationId] of operations) {
      const operation = document.paths[path]?.[method];
      expect(operation?.operationId).toBe(operationId);
      expect(operation?.security).toEqual([{ betterAuthSession: [] }]);
      expect(operation?.responses).toEqual(expect.objectContaining({ '401': expect.anything() }));
    }

    const createBody = document.paths['/api/v2/quests/{questId}/proof-submissions']?.post?.requestBody;
    expect(createBody?.content?.['application/json']).toBeDefined();
    const v2ProofOperations = operations.map(([path, method]) => document.paths[path]?.[method]);
    const openapiText = JSON.stringify(v2ProofOperations);
    expect(openapiText).not.toContain('PROOF_REJECTED');
    expect(openapiText).not.toContain('PROOF_AUTO_APPROVED');
    expect(openapiText).not.toContain('QUEST_REWORK');
    expect(openapiText).not.toContain('reworkLimit');
  });
});
