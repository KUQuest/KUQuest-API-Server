import { describe, expect, it } from 'bun:test';

import { app } from '@/app';

describe('health integration: GET /health', () => {
  it('returns service health status', async () => {
    const response = await app.handle(
      new Request('http://localhost/health'),
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('ok');
    expect(body.data.service).toBe('kuquest-api-server');
    expect(body.data.timestamp).toEqual(expect.any(String));
  });
});
