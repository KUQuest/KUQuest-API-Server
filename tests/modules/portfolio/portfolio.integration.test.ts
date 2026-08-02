import { app } from '@/app';

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

const portfolioId = randomUUID();
const basePath = '/api/v1/profile/portfolio';

const patchPortfolio = (body: unknown) =>
  app.handle(
    new Request(`http://localhost${basePath}/${portfolioId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('portfolio integration', () => {
  it('rejects an unauthenticated list', async () => {
    const response = await app.handle(new Request(`http://localhost${basePath}`));
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('requires authentication before accepting a new entry', async () => {
    const form = new FormData();
    form.set('title', 'Capstone');
    form.set('images', new File(['not-an-image'], 'a.png', { type: 'image/png' }));

    const response = await app.handle(
      new Request(`http://localhost${basePath}`, { method: 'POST', body: form }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('rejects an unauthenticated update', async () => {
    const response = await patchPortfolio({ title: 'hello' });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('rejects an unauthenticated delete', async () => {
    const response = await app.handle(
      new Request(`http://localhost${basePath}/${portfolioId}`, { method: 'DELETE' }),
    );
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
  });

  it('rejects a portfolio id that is not a uuid before authentication runs', async () => {
    const response = await app.handle(
      new Request(`http://localhost${basePath}/not-a-uuid`, { method: 'DELETE' }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  // Elysia validates the body before the auth guard runs, so every rejected-input
  // case below is reachable without a session.
  describe('rejected update input', () => {
    const cases: Array<[string, unknown]> = [
      ['an empty title', { title: '' }],
      ['a whitespace-only title', { title: '   ' }],
      ['a title beyond the maximum length', { title: 'a'.repeat(121) }],
      ['a description beyond the maximum length', { description: 'a'.repeat(1001) }],
      ['a title of the wrong type', { title: 123 }],
      ['a userId, which this endpoint does not own', { userId: 'someone-else' }],
      ['an id smuggled alongside a valid field', { title: 'ok', id: 'someone-else' }],
      ['images, which only the create endpoint accepts', { images: [] }],
    ];

    for (const [description, body] of cases) {
      it(`rejects ${description}`, async () => {
        const response = await patchPortfolio(body);

        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('VALIDATION');
      });
    }
  });

  it('accepts a title at exactly the maximum length', async () => {
    // Reaching the auth guard proves validation passed.
    const response = await patchPortfolio({ title: 'a'.repeat(120) });

    expect(response.status).toBe(401);
  });

  describe('published documentation', () => {
    const openapiDocument = async () =>
      (await (await app.handle(new Request('http://localhost/openapi/json'))).json()) as {
        paths: Record<
          string,
          Record<
            string,
            {
              requestBody?: { content?: Record<string, unknown> };
              security?: Array<Record<string, unknown>>;
            }
          >
        >;
      };

    it('publishes all four portfolio operations', async () => {
      const document = await openapiDocument();
      const collectionPath = document.paths[basePath];
      const itemPath = document.paths[`${basePath}/:portfolioId`] ?? document.paths[`${basePath}/{portfolioId}`];

      expect(collectionPath?.get).toBeDefined();
      expect(collectionPath?.post).toBeDefined();
      expect(itemPath?.patch).toBeDefined();
      expect(itemPath?.delete).toBeDefined();
    });

    it('marks every portfolio operation as requiring authentication', async () => {
      const document = await openapiDocument();
      const collectionPath = document.paths[basePath];
      const itemPath = document.paths[`${basePath}/:portfolioId`] ?? document.paths[`${basePath}/{portfolioId}`];

      expect(collectionPath?.get?.security).toEqual([{ betterAuthSession: [] }]);
      expect(collectionPath?.post?.security).toEqual([{ betterAuthSession: [] }]);
      expect(itemPath?.patch?.security).toEqual([{ betterAuthSession: [] }]);
      expect(itemPath?.delete?.security).toEqual([{ betterAuthSession: [] }]);
    });

    it('documents the create endpoint as multipart', async () => {
      const document = await openapiDocument();
      const operation = document.paths[basePath]?.post;

      expect(operation).toBeDefined();
      expect(operation?.requestBody?.content?.['multipart/form-data']).toBeDefined();
    });
  });
});
