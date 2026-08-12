import { app } from '@/app';

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

const experience = {
  title: 'Frontend Developer Intern',
  employmentType: 'Internship',
  organization: 'Tech Startup Inc.',
  description: 'Developed responsive UI components.',
  startedAt: '2023-06-01',
  endedAt: '2023-08-31',
};

const request = (path: string, method = 'GET', body?: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

describe('work experience integration', () => {
  it('requires authentication for every work experience operation', async () => {
    const cases: Array<[string, string, unknown?]> = [
      ['/api/v1/profile/experience', 'GET'],
      ['/api/v1/profile/experience', 'POST', experience],
      [`/api/v1/profile/experience/${randomUUID()}`, 'PATCH', { title: 'Updated' }],
      [`/api/v1/profile/experience/${randomUUID()}`, 'DELETE'],
    ];
    const responses = await Promise.all(
      cases.map(([path, method, body]) => request(path, method, body)),
    );

    const bodies = await Promise.all(responses.map((response) => response.json()));

    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(401);
      expect(bodies[index]).toEqual({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
      });
    }
  });

  it('validates required fields and rejects unknown fields before authentication', async () => {
    const response = await request('/api/v1/profile/experience', 'POST', {
      ...experience,
      unexpected: true,
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('publishes the CRUD operations with authentication and the documented response shapes', async () => {
    const document = (await (
      await app.handle(new Request('http://localhost/openapi/json'))
    ).json()) as {
      paths: Record<string, Record<string, { operationId?: string; security?: unknown }>>;
    };
    const collection = document.paths['/api/v1/profile/experience'];
    const item = document.paths['/api/v1/profile/experience/{experienceId}'];

    expect(collection?.get?.operationId).toBe('listOwnWorkExperience');
    expect(collection?.post?.operationId).toBe('createWorkExperience');
    expect(item?.patch?.operationId).toBe('updateWorkExperience');
    expect(item?.delete?.operationId).toBe('deleteWorkExperience');
    expect(collection?.get?.security).toEqual([{ betterAuthSession: [] }]);
    expect(item?.delete?.security).toEqual([{ betterAuthSession: [] }]);
  });
});
