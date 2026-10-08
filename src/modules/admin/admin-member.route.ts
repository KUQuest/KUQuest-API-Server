import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import {
  betterAuthAdminSecurity,
  betterAuthSecurity,
  responses,
} from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  addAdminMemberPenaltyController,
  getAdminMemberDetailController,
  getAdminMemberProfileTagsController,
  listAdminMemberCertificatesController,
  listAdminMemberPenaltyHistoryController,
  listAdminMemberHistoryController,
  listAdminMemberReviewsController,
  listAdminMemberWorkExperiencesController,
  listAdminMembersController,
  removeAdminMemberPenaltyController,
} from './admin-member.controller';
import {
  adminMemberPenaltyAddBodySchema,
  adminMemberPenaltyCommandResponseSchema,
  adminMemberPenaltyRemoveBodySchema,
  adminMemberCertificatesResponseSchema,
  adminMemberDetailResponseSchema,
  adminMemberHistoryQuerySchema,
  adminMemberHistoryResponseSchema,
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
  .get('/:id/history', listAdminMemberHistoryController, {
    params: adminMemberParamsSchema,
    query: adminMemberHistoryQuerySchema,
    response: responses(adminMemberHistoryResponseSchema, 400, 401, 403, 404, 500),
    detail: {
      tags: ['Admin Members'],
      summary: 'List a Member’s Quest and Assignment history',
      description:
        'Returns one HIRER item per Quest and one WORKER item per Assignment. Defaults include ' +
        'every Quest State and Assignment status. `questStatus` filters both roles. ' +
        '`assignmentStatus` filters Worker Assignments and Hirer Quests with a matching Assignment; ' +
        'Hirer items show only matching Workers. One bounded cursor orders both roles by record ' +
        'creation time, record ID, then role. Status dates use persisted Assignment, Quest State, ' +
        'Proof Submission review, or completion-confirmation events. The API never uses `updatedAt`.',
      operationId: 'listAdminMemberHistory',
      security: betterAuthAdminSecurity,
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
        'Returns immutable penalty records with stable record IDs, effective status, Admin notes, reversal and recalculation links, separate Misconduct and Review counts, and a version token for Add/Remove commands. Expired timed penalties remain effective until reversed.',
      operationId: 'listAdminMemberPenaltyHistory',
      security: betterAuthAdminSecurity,
    },
  })
  .post('/:id/penalty-actions/add', addAdminMemberPenaltyController, {
    params: adminMemberParamsSchema,
    body: adminMemberPenaltyAddBodySchema,
    response: responses(adminMemberPenaltyCommandResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Members'],
      summary: 'Add a direct Member Penalty',
      description:
        'Records a direct Admin Record violation in immutable Penalty History. Requires the current history version token and Idempotency-Key. An applicable PC-12 or PC-13 exemption creates an exempt record and does not accept a selected result. Direct Admin results do not count toward the automatic Misconduct ladder.',
      operationId: 'addAdminMemberPenalty',
      security: betterAuthAdminSecurity,
    },
  })
  .post('/:id/penalty-actions/remove', removeAdminMemberPenaltyController, {
    params: adminMemberParamsSchema,
    body: adminMemberPenaltyRemoveBodySchema,
    response: responses(adminMemberPenaltyCommandResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Members'],
      summary: 'Remove an effective Member Penalty',
      description:
        'Appends a reversal for any effective penalty, including expired penalties, and recalculates later automatic results from the remaining effective history. Requires the current history version token and Idempotency-Key.',
      operationId: 'removeAdminMemberPenalty',
      security: betterAuthAdminSecurity,
    },
  });
