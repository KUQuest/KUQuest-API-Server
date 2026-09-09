import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  createAdminDisputeController,
  getAdminDisputeController,
  getAdminDisputeEvidenceController,
  listAdminDisputesController,
  resolveAdminDisputeController,
} from './quest-dispute-admin.controller';
import {
  adminDisputeCommandHeadersSchema,
  adminDisputeDetailResponseSchema,
  adminDisputeEvidenceHeadersSchema,
  adminDisputeEvidenceResponseSchema,
  adminDisputeOpenBodySchema,
  adminDisputeOpenParamsSchema,
  adminDisputeOpenResponseSchema,
  adminDisputeListQuerySchema,
  adminDisputeListResponseSchema,
  adminDisputeParamsSchema,
  adminDisputeResolveBodySchema,
  adminDisputeCommandResponseSchema,
} from './quest-dispute-admin.schema';

export const adminDisputeRoute = new Elysia({
  name: 'admin-dispute-route',
  prefix: `${API_V1_PREFIX}/admin/disputes`,
})
  .use(enabledAdminGuard)
  .post('/open/:questId', createAdminDisputeController, {
    params: adminDisputeOpenParamsSchema,
    body: adminDisputeOpenBodySchema,
    response: responses(adminDisputeOpenResponseSchema, 400, 401, 403, 404, 409),
    detail: {
      tags: ['Admin Disputes'],
      summary: 'Open a Dispute Case for a Worker',
      description: 'Opens one Admin-filed Dispute Case for a Worker with an Assignment on a failed Quest within the five-day filing window.',
      operationId: 'openAdminDispute',
      security: betterAuthSecurity,
    },
  })
  .get('', listAdminDisputesController, {
    query: adminDisputeListQuerySchema,
    response: responses(adminDisputeListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Disputes'],
      summary: 'List Dispute Cases for Admin review',
      description: 'Lists bounded Dispute Case queue pages. Pending Cases are returned by default.',
      operationId: 'listAdminDisputes',
      security: betterAuthSecurity,
    },
  })
  .get('/:disputeCaseId/evidence', getAdminDisputeEvidenceController, {
    params: adminDisputeParamsSchema,
    headers: adminDisputeEvidenceHeadersSchema,
    response: responses(adminDisputeEvidenceResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Admin Disputes'],
      summary: 'Read case-scoped Dispute evidence',
      description: 'Returns only Quest, Assignment, Proof, and file metadata for this Dispute Case. The evidence access is audited as an Admin Action.',
      operationId: 'getAdminDisputeEvidence',
      security: betterAuthSecurity,
    },
  })
  .get('/:disputeCaseId', getAdminDisputeController, {
    params: adminDisputeParamsSchema,
    response: responses(adminDisputeDetailResponseSchema, 401, 403, 404),
    detail: {
      tags: ['Admin Disputes'],
      summary: 'Get Dispute Case detail for Admin review',
      description: 'Returns the Dispute Case and its failed Quest summary without unrelated Member or Conversation data.',
      operationId: 'getAdminDispute',
      security: betterAuthSecurity,
    },
  })
  .post('/:disputeCaseId/resolve', resolveAdminDisputeController, {
    params: adminDisputeParamsSchema,
    headers: adminDisputeCommandHeadersSchema,
    body: adminDisputeResolveBodySchema,
    response: responses(adminDisputeCommandResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Admin Disputes'],
      summary: 'Dismiss or resolve a Dispute Case',
      description: 'Accepts only DISPUTE_CASE_DISMISSED or DISPUTE_CASE_RESOLVED. Wallet owns the balanced financial settlement.',
      operationId: 'resolveAdminDispute',
      security: betterAuthSecurity,
    },
  });
