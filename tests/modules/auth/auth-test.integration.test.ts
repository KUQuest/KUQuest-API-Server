import { authTestRoute } from '@/modules/auth/auth-test.route';

import { describe, expect, it } from 'bun:test';
import { Elysia } from 'elysia';

const app = new Elysia().use(authTestRoute);

describe('API Test Bench assets', () => {
  it('serves the workspace and its linked assets with browser content types', async () => {
    const page = await app.handle(new Request('http://localhost/'));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    const assets = [...html.matchAll(/(?:src|href)="(\/test-bench\/[^"]+)"/g)].map((match) => match[1]!);
    expect(assets).toHaveLength(2);
    const responses = await Promise.all(assets.map((path) => app.handle(new Request(`http://localhost${path}`))));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.map((response) => response.headers.get('content-type'))).toEqual(
      expect.arrayContaining([expect.stringContaining('text/css'), expect.stringContaining('javascript')]),
    );
  });

  it('does not expose arbitrary files through the asset prefix', async () => {
    const response = await app.handle(new Request('http://localhost/test-bench/.env'));
    expect(response.status).toBe(404);
  });
});
