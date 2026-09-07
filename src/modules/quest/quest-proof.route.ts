import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  confirmProofFreeWorkController,
  listProofsController,
  reviewProofController,
  submitProofController,
} from './quest-proof.controller';
import {
  proofConfirmationResponseSchema,
  proofConfirmationSchema,
  proofDetailParamsSchema,
  proofListResponseSchema,
  proofParamsSchema,
  proofResponseSchema,
  proofReviewResponseSchema,
  proofReviewSchema,
  proofSubmitSchema,
} from './quest-proof.schema';

export const questProofRoute = new Elysia({ name: 'quest-proof-route', prefix: '/api/v1/quests' })
  .use(authGuard)
  .post('/:questId/proof', submitProofController, {
    params: proofParamsSchema,
    body: proofSubmitSchema,
    type: 'multipart/form-data',
    transform: rejectUnknownFields(proofSubmitSchema),
    response: responses(proofResponseSchema, 400, 401, 404, 409, 413, 415, 502),
    detail: { tags: ['Quest Proof'], summary: 'Submit Quest proof', operationId: 'submitQuestProof', security: betterAuthSecurity },
  })
  .get('/:questId/proof', listProofsController, {
    params: proofParamsSchema,
    response: responses(proofListResponseSchema, 401, 404),
    detail: { tags: ['Quest Proof'], summary: 'List Quest Proof Submissions', operationId: 'listQuestProofs', security: betterAuthSecurity },
  })
  .post('/:questId/proof/confirm', confirmProofFreeWorkController, {
    params: proofParamsSchema,
    body: proofConfirmationSchema,
    transform: rejectUnknownFields(proofConfirmationSchema),
    response: responses(proofConfirmationResponseSchema, 401, 404, 409),
    detail: { tags: ['Quest Proof'], summary: 'Confirm proof-free Quest work', operationId: 'confirmQuestWork', security: betterAuthSecurity },
  })
  .post('/:questId/proof/:proofId/review', reviewProofController, {
    params: proofDetailParamsSchema,
    body: proofReviewSchema,
    response: responses(proofReviewResponseSchema, 400, 401, 404, 409, 503),
    detail: { tags: ['Quest Proof'], summary: 'Review a Quest Proof Submission', operationId: 'reviewQuestProof', security: betterAuthSecurity },
  });
