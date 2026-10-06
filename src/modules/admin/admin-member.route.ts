import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import {
  betterAuthAdminSecurity,
  betterAuthSecurity,
  responses,
} from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  getAdminMemberDetailController,
  getAdminMemberProfileTagsController,
  listAdminMemberCertificatesController,
  listAdminMemberPenaltyHistoryController,
  listAdminMemberReviewsController,
  listAdminMemberWorkExperiencesController,
  listAdminMembersController,
} from './admin-member.controller';
import {
  adminMemberCertificatesResponseSchema,
  adminMemberDetailResponseSchema,
  adminMemberListQuerySchema,
  adminMemberListResponseSchema,
  adminMemberParamsSchema,
  adminMemberProfileCollectionQuerySchema,
  adminMemberProfileTagsResponseSchema,
  adminMemberWorkExperiencesResponseSchema,
  adminMemberPenaltyHistoryResponseSchema,
  adminMemberReviewsQuerySchema,
  adminMemberReviewsResponseSchema,
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
      description:
        'Lists students and staff with academic affiliation, status, and wallet summary.',
      operationId: 'listAdminMembers',
      security: betterAuthSecurity,
    },
  })
  .get('/:id/reviews', listAdminMemberReviewsController, {
    params: adminMemberParamsSchema,
    query: adminMemberReviewsQuerySchema,
    response: responses(adminMemberReviewsResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Members'],
      summary: 'List Reviews received by a Member',
      description:
        'Lists received Reviews with rating, comment, dates, Reviewer and Quest display IDs, and the current Quest State. The Review has no status.',
      operationId: 'listAdminMemberReviews',
      security: betterAuthAdminSecurity,
    },
  })
  .get('/:id', getAdminMemberDetailController, {
    params: adminMemberParamsSchema,
    response: responses(adminMemberDetailResponseSchema, 400, 401, 403, 404),
    detail: {
      tags: ['Admin Members'],
      summary: 'Get Member Detail and Marketplace Performance Statistics',
      description:
        'Returns member profile, academic details, wallet compartments, and quest/review stats.',
      operationId: 'getAdminMemberDetail',
      security: betterAuthSecurity,
    },
  })
  .get('/:id/profile-tags', getAdminMemberProfileTagsController, {
    params: adminMemberParamsSchema,
    response: responses(adminMemberProfileTagsResponseSchema, 400, 401, 403, 404, 500),
    detail: {
      tags: ['Admin Members'],
      summary: 'List a Member’s Profile Tags',
      description: 'Returns up to three Tags derived from completed Worker Assignments.',
      operationId: 'getAdminMemberProfileTags',
      security: betterAuthSecurity,
    },
  })
  .get('/:id/work-experiences', listAdminMemberWorkExperiencesController, {
    params: adminMemberParamsSchema,
    query: adminMemberProfileCollectionQuerySchema,
    response: responses(adminMemberWorkExperiencesResponseSchema, 400, 401, 403, 404, 500),
    detail: {
      tags: ['Admin Members'],
      summary: 'List a Member’s Work Experience',
      description: 'Returns Work Experience with bounded cursor pagination and a total count.',
      operationId: 'listAdminMemberWorkExperiences',
      security: betterAuthSecurity,
    },
  })
  .get('/:id/certificates', listAdminMemberCertificatesController, {
    params: adminMemberParamsSchema,
    query: adminMemberProfileCollectionQuerySchema,
    response: responses(adminMemberCertificatesResponseSchema, 400, 401, 403, 404, 500),
    detail: {
      tags: ['Admin Members'],
      summary: 'List a Member’s Certificates',
      description:
        'Returns Certificates with bounded cursor pagination and safe image metadata. It does not return storage URLs or storage object details.',
      operationId: 'listAdminMemberCertificates',
      security: betterAuthSecurity,
    },
  })
  .get('/:id/penalty-history', listAdminMemberPenaltyHistoryController, {
    params: adminMemberParamsSchema,
    query: adminMemberProfileCollectionQuerySchema,
    response: responses(adminMemberPenaltyHistoryResponseSchema, 400, 401, 403, 404, 500),
    detail: {
      tags: ['Admin Members'],
      summary: 'List a Member’s Penalty History',
      description:
        'Returns immutable penalty records and separate Misconduct and Review ladder counts with safe source Display IDs.',
      operationId: 'listAdminMemberPenaltyHistory',
      security: betterAuthSecurity,
    },
  });
