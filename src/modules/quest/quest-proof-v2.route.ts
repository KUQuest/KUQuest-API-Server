import { authGuard } from '@/modules/auth';
import { betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V2_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  confirmQuestV2CompletionController,
  createQuestV2ProofSubmissionController,
  deleteQuestV2ProofSubmissionController,
  editQuestV2ProofSubmissionController,
  listQuestV2ProofSubmissionsController,
  submitQuestV2ProofSubmissionController,
} from './quest-proof-v2.controller';
import {
  questV2CompletionConfirmationResponseSchema,
  questV2ProofSubmissionCreateSchema,
  questV2ProofSubmissionDeleteResponseSchema,
  questV2ProofSubmissionDetailParamsSchema,
  questV2ProofSubmissionEditSchema,
  questV2ProofSubmissionHeadersSchema,
  questV2ProofSubmissionListResponseSchema,
  questV2ProofSubmissionParamsSchema,
  questV2ProofSubmissionResponseSchema,
} from './quest-proof-v2.schema';
import { createQuestIdempotencyKeyGuard } from './quest-idempotency.guard';

export const questProofV2Route = new Elysia({
  name: 'quest-proof-v2-route',
  prefix: `${API_V2_PREFIX}/quests`,
})
  .use(createQuestIdempotencyKeyGuard('proof-submission-v2'))
  .use(authGuard)
  .post('/:questId/proof-submissions', createQuestV2ProofSubmissionController, {
    params: questV2ProofSubmissionParamsSchema,
    body: questV2ProofSubmissionCreateSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    transform: rejectUnknownFields(questV2ProofSubmissionCreateSchema),
    response: responses(questV2ProofSubmissionResponseSchema, { successStatus: 201 }, 400, 401, 403, 404, 409, 413, 415, 500, 502, 503),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Create a v2 Proof Submission Draft',
      description: 'Creates an unsent Proof Submission Draft for the required submitter of an in-progress v2 Quest.',
      operationId: 'createQuestV2ProofSubmission',
      security: betterAuthSecurity,
    },
  })
  .patch('/:questId/proof-submissions/:proofSubmissionId', editQuestV2ProofSubmissionController, {
    params: questV2ProofSubmissionDetailParamsSchema,
    body: questV2ProofSubmissionEditSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    transform: rejectUnknownFields(questV2ProofSubmissionEditSchema),
    response: responses(questV2ProofSubmissionResponseSchema, 400, 401, 403, 404, 409, 413, 415, 500, 502, 503),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Edit a v2 Proof Submission Draft',
      description: 'Edits the required submitter’s unsent Proof Submission Draft before dueAt.',
      operationId: 'editQuestV2ProofSubmission',
      security: betterAuthSecurity,
    },
  })
  .delete('/:questId/proof-submissions/:proofSubmissionId', deleteQuestV2ProofSubmissionController, {
    params: questV2ProofSubmissionDetailParamsSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    response: responses(questV2ProofSubmissionDeleteResponseSchema, 400, 401, 403, 404, 409, 500, 503),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Delete a v2 Proof Submission Draft',
      description: 'Deletes the required submitter’s unsent Proof Submission Draft before dueAt.',
      operationId: 'deleteQuestV2ProofSubmission',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/proof-submissions/:proofSubmissionId/submit', submitQuestV2ProofSubmissionController, {
    params: questV2ProofSubmissionDetailParamsSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    response: responses(questV2ProofSubmissionResponseSchema, 400, 401, 403, 404, 409, 500, 503),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Send a v2 Proof Submission Draft',
      description: 'Sends and locks a complete Proof Submission Draft before dueAt.',
      operationId: 'submitQuestV2ProofSubmission',
      security: betterAuthSecurity,
    },
  })
  .get('/:questId/proof-submissions', listQuestV2ProofSubmissionsController, {
    params: questV2ProofSubmissionParamsSchema,
    response: responses(questV2ProofSubmissionListResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'List v2 Proof Submissions',
      description: 'Returns role-filtered Proof Submission views. Drafts are visible only to their submitter.',
      operationId: 'listQuestV2ProofSubmissions',
      security: betterAuthSecurity,
    },
  })
  .post('/:questId/completion-confirmation', confirmQuestV2CompletionController, {
    params: questV2ProofSubmissionParamsSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    response: responses(questV2CompletionConfirmationResponseSchema, 400, 401, 403, 404, 409, 500, 503),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Confirm proof-free v2 Quest completion',
      description: 'Records completion for the required submitter when proofRequired is false without creating a Proof Submission.',
      operationId: 'confirmQuestV2Completion',
      security: betterAuthSecurity,
    },
  });
