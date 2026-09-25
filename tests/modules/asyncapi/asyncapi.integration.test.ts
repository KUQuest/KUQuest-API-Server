import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

describe('AsyncAPI document', () => {
  it('serves the spec without authentication', async () => {
    const response = await app.handle(new Request('http://localhost/asyncapi.yaml'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/yaml; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="asyncapi.yaml"'
    );

    const document = await response.text();
    expect(document).toContain('asyncapi: 3.1.0');
    expect(document).toContain('address: /api/v2/quests/{questId}/candidate-roster/events');
    expect(document).toContain('address: /api/v1/chat/conversations/{conversationId}/events');
    expect(document).toContain('address: /api/v1/chat/candidate-inquiries/{conversationId}/events');
    expect(document).toContain('name: WORK_CONVERSATION_MESSAGE');
    expect(document).toContain('name: CANDIDATE_INQUIRY_MESSAGE');
    expect(document).toContain('?traceId=<uuid>');
  });
});
