import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { listTags } from './tag.controller';
import { tagListResponseSchema } from './tag.schema';

export const tagRoute = new Elysia({
  name: 'tag-route',
  prefix: `${API_V1_PREFIX}/tags`,
})
  .use(authGuard)
  .get('', listTags, {
    response: responses(tagListResponseSchema, 401),
    detail: {
      tags: ['Tags'],
      summary: 'List Tags',
      description: 'Returns all Tags available to authenticated Members, ordered by name.',
      operationId: 'listTags',
      security: betterAuthSecurity,
    },
  });
