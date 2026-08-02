import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  createOwnPortfolio,
  deleteOwnPortfolio,
  listOwnPortfolio,
  updateOwnPortfolio,
} from './portfolio.controller';
import {
  portfolioCreateResponseSchema,
  portfolioCreateSchema,
  portfolioListRespondSchema,
  portfolioParamSchema,
  portfolioUpdateSchema,
} from './portfolio.schema';

export const portfolioRoute = new Elysia({
  name: 'portfolio-route',
  prefix: `${API_V1_PREFIX}/profile/portfolio`,
})
  .use(authGuard)
  .get('', listOwnPortfolio, {
    response: responses(portfolioListRespondSchema, 401),
    detail: {
      tags: ['Portfolio'],
      summary: 'List own portfolio',
      description: 'Returns the authenticated student portfolio entries in display order.',
      operationId: 'listOwnPortfolio',
      security: betterAuthSecurity,
    },
  })
  .post('', createOwnPortfolio, {
    body: portfolioCreateSchema,
    type: 'multipart/form-data',
    response: responses(portfolioCreateResponseSchema, 400, 401, 413, 415, 502),
    detail: {
      tags: ['Portfolio'],
      summary: 'Create a portfolio entry',
      description:
        'Creates a portfolio entry with up to 10 images and stores their file references.',
      operationId: 'createOwnPortfolio',
      security: betterAuthSecurity,
    },
  })
  .patch('/:portfolioId', updateOwnPortfolio, {
    params: portfolioParamSchema,
    body: portfolioUpdateSchema,
    transform: rejectUnknownFields(portfolioUpdateSchema),
    response: responses(apiSuccessSchema, 400, 401, 404),
    detail: {
      tags: ['Portfolio'],
      summary: 'Update a portfolio entry',
      description:
        'Updates the title or description of a portfolio entry owned by the authenticated student.',
      operationId: 'updateOwnPortfolio',
      security: betterAuthSecurity,
    },
  })
  .delete('/:portfolioId', deleteOwnPortfolio, {
    params: portfolioParamSchema,
    response: responses(apiSuccessSchema, 401, 404),
    detail: {
      tags: ['Portfolio'],
      summary: 'Delete a portfolio entry',
      description:
        'Deletes a portfolio entry owned by the authenticated student and removes its stored images.',
      operationId: 'deleteOwnPortfolio',
      security: betterAuthSecurity,
    },
  });
