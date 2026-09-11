import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  getAdminMemberDetailController,
  listAdminMembersController,
} from './admin-member.controller';
import {
  adminMemberDetailResponseSchema,
  adminMemberListQuerySchema,
  adminMemberListResponseSchema,
  adminMemberParamsSchema,
} from './admin-member.schema';

export const adminMemberRoute = new Elysia({
  name: 'admin-member-route',
  prefix: `${API_V1_PREFIX}/admin/members`,
})
  .use(enabledAdminGuard)
  .get('', listAdminMembersController, {
    query: adminMemberListQuerySchema,
    response: responses(adminMemberListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Members'],
      summary: 'Search and List University Members',
      description: 'Lists students and staff with academic affiliation, status, and wallet summary.',
      operationId: 'listAdminMembers',
      security: betterAuthSecurity,
    },
  })
  .get('/:id', getAdminMemberDetailController, {
    params: adminMemberParamsSchema,
    response: responses(adminMemberDetailResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Members'],
      summary: 'Get Member Detail and Marketplace Performance Statistics',
      description: 'Returns member profile, academic details, wallet compartments, and quest/review stats.',
      operationId: 'getAdminMemberDetail',
      security: betterAuthSecurity,
    },
  });
