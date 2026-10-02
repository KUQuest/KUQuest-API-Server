import { authGuard, memberBanGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';

import { Elysia } from 'elysia';

import { listTags } from './tag.controller';
import { tagListQuerySchema, tagListResponseSchema } from './tag.schema';

export const tagRoute = new Elysia({
  name: 'tag-route',
  prefix: `${API_V1_PREFIX}/tags`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .get('', listTags, {
    query: tagListQuerySchema,
    response: responses(tagListResponseSchema, 400, 401),
    detail: {
      tags: ['Tags'],
      summary: 'Search and List Tags',
      description:
        'Returns paginated Tags available to authenticated Members, with optional keyword search and paging.',
      operationId: 'listTags',
      security: betterAuthSecurity,
    },
  });
