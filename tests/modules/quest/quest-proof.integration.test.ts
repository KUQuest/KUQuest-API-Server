import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const proofId = '018f47a7-1c7d-7c98-9a11-690d7e834301';

const request = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe('Quest Proof HTTP contract', () => {
  it('validates proof submissions before authentication', async () => {
    const response = await request('POST', `/api/v1/quests/${questId}/proof`, { unknown: true });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('requires Member authentication for proof commands', async () => {
    const responses = await Promise.all([
      request('GET', `/api/v1/quests/${questId}/proof`),
      request('POST', `/api/v1/quests/${questId}/proof/confirm`, {}),
      request('POST', `/api/v1/quests/${questId}/proof/${proofId}/review`, { status: 'PROOF_APPROVED' }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
  });

  it('publishes proof routes in OpenAPI', async () => {
    const response = await request('GET', '/openapi/json');
    const document = await response.json() as { paths: Record<string, Record<string, { operationId?: string }>> };
    expect(document.paths['/api/v1/quests/{questId}/proof']?.post?.operationId).toBe('submitQuestProof');
    expect(document.paths['/api/v1/quests/{questId}/proof/{proofId}/review']?.post?.operationId).toBe('reviewQuestProof');
  });
});
