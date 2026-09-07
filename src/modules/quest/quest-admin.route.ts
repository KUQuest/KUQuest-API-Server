import { enabledAdminGuard } from '@/modules/auth';
import { API_V1_PREFIX } from '@/shared/api-version';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';

import { Elysia } from 'elysia';

import {
  getAdminQuestDetailController,
  hideAdminQuestController,
  listAdminQuestsController,
  restoreAdminQuestController,
  terminateAdminQuestController,
} from './quest-admin.controller';
import {
  adminQuestCommandHeadersSchema,
  adminQuestCommandResponseSchema,
  adminQuestDetailResponseSchema,
  adminQuestHideBodySchema,
  adminQuestListQuerySchema,
  adminQuestListResponseSchema,
  adminQuestParamsSchema,
  adminQuestRestoreBodySchema,
  adminQuestTerminateBodySchema,
} from './quest-admin.schema';

export const adminQuestRoute = new Elysia({
  name: 'admin-quest-route',
  prefix: `${API_V1_PREFIX}/admin/quests`,
})
  .use(enabledAdminGuard)
  .get('', listAdminQuestsController, {
    query: adminQuestListQuerySchema,
    response: responses(adminQuestListResponseSchema, 400, 401, 403),
    detail: {
      tags: ['Admin Quests'],
      summary: 'List Quests for Admin review',
      description: 'Lists Quests across every state, mode, and participation shape, including hidden Quests, using bounded cursor pagination and safe filters.',
      operationId: 'listAdminQuests',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId', getAdminQuestDetailController, {
    params: adminQuestParamsSchema,
    response: responses(adminQuestDetailResponseSchema, 401, 403, 404),
    detail: {
      tags: ['Admin Quests'],
      summary: 'Get Quest detail for Admin review',
      description: 'Reads Quest facts, Hirer, Candidates, Workers, Assignments, proof and file references, financial facts, edit history, and Admin Action history without secrets or unrelated Member data.',
      operationId: 'getAdminQuestDetail',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/hide', hideAdminQuestController, {
    params: adminQuestParamsSchema,
    headers: adminQuestCommandHeadersSchema,
    body: adminQuestHideBodySchema,
    response: responses(adminQuestCommandResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Admin Quests'],
      summary: 'Hide a Quest from Member discovery',
      description: 'Applies an Admin visibility overlay without changing Quest State, Assignment, Quest Escrow, or Work Conversation membership.',
      operationId: 'hideAdminQuest',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/restore', restoreAdminQuestController, {
    params: adminQuestParamsSchema,
    headers: adminQuestCommandHeadersSchema,
    body: adminQuestRestoreBodySchema,
    response: responses(adminQuestCommandResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Admin Quests'],
      summary: 'Restore a hidden Quest to discovery',
      description: 'Clears the Admin visibility overlay only when the Quest remains eligible for its OPEN lifecycle state.',
      operationId: 'restoreAdminQuest',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/terminate', terminateAdminQuestController, {
    params: adminQuestParamsSchema,
    headers: adminQuestCommandHeadersSchema,
    body: adminQuestTerminateBodySchema,
    response: responses(adminQuestCommandResponseSchema, 400, 401, 403, 404, 409, 503),
    detail: {
      tags: ['Admin Quests'],
      summary: 'Terminate a Quest under Admin policy',
      description: 'Runs the Quest-owned cancellation settlement and closes Assignments and Work Conversation membership atomically with the Admin Action.',
      operationId: 'terminateAdminQuest',
      security: betterAuthSecurity,
    },
  });
