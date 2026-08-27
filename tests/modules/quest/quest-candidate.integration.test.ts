import { app } from '@/app';

import { describe, expect, it } from 'bun:test';

const questId = '018f47a7-1c7d-7c98-9a11-690d7e83430c';
const invitationId = '018f47a7-1c7d-7c98-9a11-690d7e834301';

const request = (method: string, path: string, body?: unknown) => app.handle(new Request(`http://localhost${path}`, {
  method,
  headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}));

describe('Quest Candidate HTTP contract', () => {
  it('validates application bodies before authentication', async () => {
    const response = await request('POST', `/api/v1/quests/${questId}/applications`, { unknown: true });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('requires Member authentication for Candidate resources', async () => {
    const responses = await Promise.all([
      request('POST', `/api/v1/quests/${questId}/applications`),
      request('GET', `/api/v1/quests/${questId}/teams`),
      request('GET', '/api/v1/quests/invitations'),
      request('POST', `/api/v1/quests/invitations/${invitationId}/accept`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    expect(bodies.map((body) => body.error.code)).toEqual([
      'UNAUTHORIZED',
      'UNAUTHORIZED',
      'UNAUTHORIZED',
      'UNAUTHORIZED',
    ]);
  });

  it('requires a non-blank Idempotency-Key for selection', async () => {
    const absent = await request('POST', `/api/v1/quests/${questId}/applications/${invitationId}/select`);
    expect(absent.status).toBe(400);
    expect((await absent.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const whitespace = await app.handle(new Request(`http://localhost/api/v1/quests/${questId}/teams/${invitationId}/select`, {
      method: 'POST',
      headers: { 'Idempotency-Key': '   ' },
    }));
    expect(whitespace.status).toBe(400);
    expect((await whitespace.json()).error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('publishes Candidate, Team, and invitation operations in OpenAPI', async () => {
    const response = await request('GET', '/openapi/json');
    const document = (await response.json()) as { paths: Record<string, Record<string, { operationId?: string }>> };
    expect(document.paths['/api/v1/quests/{questId}/applications']?.post?.operationId).toBe('createQuestApplication');
    expect(document.paths['/api/v1/quests/{questId}/teams']?.post?.operationId).toBe('createQuestTeam');
    expect(document.paths['/api/v1/quests/{questId}/applications/{applicationId}/select']?.post?.operationId).toBe('selectQuestApplication');
    expect(document.paths['/api/v1/quests/{questId}/teams/{teamId}/select']?.post?.operationId).toBe('selectQuestTeam');
    expect(document.paths['/api/v1/quests/{questId}/teams/{teamId}/invitations']?.post?.operationId).toBe('createQuestTeamInvitation');
    expect(document.paths['/api/v1/quests/invitations/{invitationId}/accept']?.post?.operationId).toBe('acceptQuestTeamInvitation');
    expect(document.paths['/api/v1/quests/{questId}/teams/{teamId}/leave']?.post?.operationId).toBe('leaveQuestTeam');
    expect(document.paths['/api/v1/quests/{questId}/teams/{teamId}/members/{memberId}']?.delete?.operationId).toBe('removeQuestTeamMember');
    expect(document.paths['/api/v1/quests/{questId}/teams/{teamId}/submit']?.post?.operationId).toBe('submitQuestTeam');
  });
});
