import { authGuard, memberBanGuard } from '@/modules/auth';
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
  getQuestV2ProofFileController,
  listQuestV2CompletionConfirmationsController,
  reviewQuestV2ProofSubmissionController,
  reviewQuestV2CompletionConfirmationController,
  submitQuestV2ProofSubmissionController,
} from './quest-proof-v2.controller';
import {
  questV2CompletionConfirmationResponseSchema,
  questV2CompletionConfirmationParamsSchema,
  questV2CompletionConfirmationDetailParamsSchema,
  questV2CompletionConfirmationListResponseSchema,
  questV2CompletionConfirmationReviewResponseSchema,
  questV2CompletionConfirmationReviewSchema,
  questV2ProofSubmissionCreateSchema,
  questV2ProofSubmissionDeleteResponseSchema,
  questV2ProofSubmissionDetailParamsSchema,
  questV2ProofSubmissionEditSchema,
  questV2ProofSubmissionHeadersSchema,
  questV2ProofSubmissionListResponseSchema,
  questV2ProofFileParamsSchema,
  questV2ProofFileResponseSchema,
  questV2ProofSubmissionParamsSchema,
  questV2ProofSubmissionResponseSchema,
  questV2ProofSubmissionReviewResponseSchema,
  questV2ProofSubmissionReviewSchema,
} from './quest-proof-v2.schema';

export const questProofV2Route = new Elysia({
  name: 'quest-proof-v2-route',
  prefix: `${API_V2_PREFIX}/quests`,
})
  .use(authGuard)
  .use(memberBanGuard)
  .post('/:questId/proof-submissions', createQuestV2ProofSubmissionController, {
    params: questV2ProofSubmissionParamsSchema,
    body: questV2ProofSubmissionCreateSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    transform: rejectUnknownFields(questV2ProofSubmissionCreateSchema),
    response: responses(
      questV2ProofSubmissionResponseSchema,
      { successStatus: 201 },
      400,
      401,
      403,
      404,
      409,
      413,
      415,
      422,
      500,
      502,
      503
    ),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Create a v2 Proof Submission Draft',
      description:
        'Creates an unsent Proof Submission Draft for the required submitter of an in-progress v2 Quest. The create replaces the submitter’s own unsent Draft; after send it returns 409 PROOF_SUBMISSION_ALREADY_EXISTS. Each image must be at most 10 MB and 25 megapixels; larger images return 422 PROOF_FILE_DIMENSIONS_TOO_LARGE.',
      operationId: 'createQuestV2ProofSubmission',
      security: betterAuthSecurity,
    },
  })
  .patch('/:questId/proof-submissions/:proofSubmissionId', editQuestV2ProofSubmissionController, {
    params: questV2ProofSubmissionDetailParamsSchema,
    body: questV2ProofSubmissionEditSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    transform: rejectUnknownFields(questV2ProofSubmissionEditSchema),
    response: responses(
      questV2ProofSubmissionResponseSchema,
      400,
      401,
      403,
      404,
      409,
      413,
      415,
      422,
      500,
      502,
      503
    ),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Edit a v2 Proof Submission Draft',
      description:
        'Edits the required submitter’s unsent Proof Submission Draft before dueAt. Retry a failed image with retryPosition; images must be at most 25 megapixels, or the Server returns 422 PROOF_FILE_DIMENSIONS_TOO_LARGE.',
      operationId: 'editQuestV2ProofSubmission',
      security: betterAuthSecurity,
    },
  })
  .delete(
    '/:questId/proof-submissions/:proofSubmissionId',
    deleteQuestV2ProofSubmissionController,
    {
      params: questV2ProofSubmissionDetailParamsSchema,
      headers: questV2ProofSubmissionHeadersSchema,
      response: responses(
        questV2ProofSubmissionDeleteResponseSchema,
        400,
        401,
        403,
        404,
        409,
        500,
        503
      ),
      detail: {
        tags: ['Quest Proof v2'],
        summary: 'Delete a v2 Proof Submission Draft',
        description: 'Deletes the required submitter’s unsent Proof Submission Draft before dueAt.',
        operationId: 'deleteQuestV2ProofSubmission',
        security: betterAuthSecurity,
      },
    }
  )
  .post(
    '/:questId/proof-submissions/:proofSubmissionId/submit',
    submitQuestV2ProofSubmissionController,
    {
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
    }
  )
  .post(
    '/:questId/proof-submissions/:proofSubmissionId/review',
    reviewQuestV2ProofSubmissionController,
    {
      params: questV2ProofSubmissionDetailParamsSchema,
      body: questV2ProofSubmissionReviewSchema,
      headers: questV2ProofSubmissionHeadersSchema,
      transform: rejectUnknownFields(questV2ProofSubmissionReviewSchema),
      response: responses(
        questV2ProofSubmissionReviewResponseSchema,
        400,
        401,
        403,
        404,
        409,
        500,
        503
      ),
      detail: {
        tags: ['Quest Proof v2'],
        summary: 'Review a v2 Proof Submission',
        description:
          'Records the Hirer’s first final approval or non-approval decision for a sent Proof Submission. Non-approval makes the Assignment ASSIGNMENT_INCOMPLETE. In GROUP + FIRST_COME_FIRST_SERVED, `questStatus` stays QUEST_IN_PROGRESS while another Worker is Active; when the last Active Worker has a result, the Quest becomes QUEST_COMPLETED if one Worker completed, otherwise QUEST_FAILED. In every other mode, non-approval makes the Quest QUEST_FAILED.',
        operationId: 'reviewQuestV2ProofSubmission',
        security: betterAuthSecurity,
      },
    }
  )
  .get('/:questId/proof-submissions', listQuestV2ProofSubmissionsController, {
    params: questV2ProofSubmissionParamsSchema,
    response: responses(questV2ProofSubmissionListResponseSchema, 401, 404, 500),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'List v2 Proof Submissions',
      description:
        'Returns role-filtered Proof Submission views. Drafts are visible only to their submitter. FULL-visible file rows include a short-lived `url` and `urlExpiresAt`; both are null when the file is failed, missing, deleted, or its link is unavailable. SUMMARY views do not include file rows.',
      operationId: 'listQuestV2ProofSubmissions',
      security: betterAuthSecurity,
    },
  })
  .get(
    '/:questId/proof-submissions/:proofSubmissionId/files/:fileId',
    getQuestV2ProofFileController,
    {
      params: questV2ProofFileParamsSchema,
      response: responses(questV2ProofFileResponseSchema, 401, 404, 503),
      detail: {
        tags: ['Quest Proof v2'],
        summary: 'Get a temporary v2 Proof file link',
        description:
          'Returns a short-lived link for a ready Proof file to its submitting Worker or the Quest Hirer.',
        operationId: 'getQuestV2ProofFile',
        security: betterAuthSecurity,
      },
    }
  )
  .get('/:questId/completion-confirmations', listQuestV2CompletionConfirmationsController, {
    params: questV2CompletionConfirmationParamsSchema,
    response: responses(questV2CompletionConfirmationListResponseSchema, 401, 403, 404, 500),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'List v2 Completion Confirmations',
      description:
        'Returns Completion Confirmations to the Hirer and affected Workers. The Hirer sees every Confirmation. A Worker sees the Confirmation for their Assignment or selected Team. The reason is visible only to the Hirer and the submitter.',
      operationId: 'listQuestV2CompletionConfirmations',
      security: betterAuthSecurity,
    },
  })
  .post(
    '/:questId/completion-confirmations/:completionConfirmationId/review',
    reviewQuestV2CompletionConfirmationController,
    {
      params: questV2CompletionConfirmationDetailParamsSchema,
      body: questV2CompletionConfirmationReviewSchema,
      headers: questV2ProofSubmissionHeadersSchema,
      transform: rejectUnknownFields(questV2CompletionConfirmationReviewSchema),
      response: responses(
        questV2CompletionConfirmationReviewResponseSchema,
        400,
        401,
        403,
        404,
        409,
        500,
        503
      ),
      detail: {
        tags: ['Quest Proof v2'],
        summary: 'Review a v2 Completion Confirmation',
        description:
          'Records the Hirer’s first approval or non-approval decision. A non-approval requires a reason and creates an Admin Review Item. The Server approves the Confirmation after 24 hours if the Hirer does not decide.',
        operationId: 'reviewQuestV2CompletionConfirmation',
        security: betterAuthSecurity,
      },
    }
  )
  .post('/:questId/completion-confirmation', confirmQuestV2CompletionController, {
    params: questV2ProofSubmissionParamsSchema,
    headers: questV2ProofSubmissionHeadersSchema,
    response: responses(
      questV2CompletionConfirmationResponseSchema,
      400,
      401,
      403,
      404,
      409,
      500,
      503
    ),
    detail: {
      tags: ['Quest Proof v2'],
      summary: 'Confirm proof-free v2 Quest completion',
      description:
        'Records completion for the required submitter when proofRequired is false without creating a Proof Submission.',
      operationId: 'confirmQuestV2Completion',
      security: betterAuthSecurity,
    },
  });
