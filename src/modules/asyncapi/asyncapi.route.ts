import { resolve } from 'node:path';

import { Elysia } from 'elysia';

const asyncApiFile = Bun.file(resolve(process.cwd(), 'asyncapi.yaml'));

export const asyncApiRoute = new Elysia({ name: 'asyncapi-route' }).get(
  '/asyncapi.yaml',
  () =>
    new Response(asyncApiFile, {
      headers: {
        'content-type': 'application/yaml; charset=utf-8',
        'content-disposition': 'attachment; filename="asyncapi.yaml"',
      },
    }),
  { detail: { hide: true } }
);
