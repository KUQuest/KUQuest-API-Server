import { t, type Static } from 'elysia';

import { questV2States } from './quest-v2.contract';

const proofStatus = t.Union([
  t.Literal('PROOF_PENDING'),
  t.Literal('PROOF_APPROVED'),
  t.Literal('PROOF_NOT_APPROVED'),
]);

const description = t.Nullable(t.String({ maxLength: 1000, pattern: '\\S' }));
const fileIds = t.Array(t.String({ format: 'uuid' }), { maxItems: 5, uniqueItems: true });

export const questV2ProofSubmissionParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
});

export const questV2ProofSubmissionDetailParamsSchema = t.Object({
  questId: t.String({ format: 'uuid' }),
  proofSubmissionId: t.String({ format: 'uuid' }),
});

export const questV2ProofSubmissionHeadersSchema = t.Object({
  'idempotency-key': t.String({
    minLength: 1,
    maxLength: 200,
    pattern: '\\S',
    description: 'Non-blank command identity for replay-safe Proof Submission commands',
  }),
});

const proofDraftProperties = {
  description: t.Optional(description),
  fileIds: t.Optional(fileIds),
  files: t.Optional(t.Files({ maxItems: 5 })),
  retryPosition: t.Optional(t.Integer({
    minimum: 0,
    maximum: 4,
    description: 'Position of the one failed Proof file being retried',
  })),
};

export const questV2ProofSubmissionCreateSchema = t.Object(proofDraftProperties, {
  additionalProperties: false,
});

export const questV2ProofSubmissionEditSchema = t.Object(proofDraftProperties, {
  additionalProperties: false,
  minProperties: 1,
});

export const questV2ProofSubmissionEmptyBodySchema = t.Object({}, {
  additionalProperties: false,
});

const proofStatusSchema = t.Nullable(proofStatus);
const visibilitySchema = t.Union([t.Literal('FULL'), t.Literal('SUMMARY')]);

const proofFileSchema = t.Object({
  fileId: t.Nullable(t.String({ format: 'uuid' })),
  contentType: t.Nullable(t.String()),
  sizeBytes: t.Nullable(t.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 })),
  position: t.Integer({ minimum: 0, maximum: 4 }),
  uploadStatus: t.Union([t.Literal('PROOF_FILE_READY'), t.Literal('PROOF_FILE_FAILED')]),
  failureCode: t.Nullable(t.String({ minLength: 1, maxLength: 64 })),
});

const proofSubmissionSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.Nullable(t.String({ format: 'uuid' })),
  teamId: t.Nullable(t.String({ format: 'uuid' })),
  submittedByUserId: t.String({ format: 'uuid' }),
  description: t.Nullable(t.String()),
  status: proofStatusSchema,
  submittedAt: t.Nullable(t.String({ format: 'date-time' })),
  createdAt: t.String({ format: 'date-time' }),
  updatedAt: t.String({ format: 'date-time' }),
  visibility: visibilitySchema,
  fileIds: t.Array(t.String({ format: 'uuid' }), { maxItems: 5 }),
  files: t.Array(proofFileSchema, { maxItems: 5 }),
});

export const questV2ProofSubmissionResponseSchema = t.Object({
  success: t.Literal(true),
  data: proofSubmissionSchema,
});

export const questV2ProofSubmissionListResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ items: t.Array(proofSubmissionSchema) }),
});

export const questV2ProofSubmissionDeleteResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    deleted: t.Literal(true),
    proofSubmissionId: t.String({ format: 'uuid' }),
  }),
});

const questV2State = t.Union(
  questV2States.map((value) => t.Literal(value)) as [
    ReturnType<typeof t.Literal<string>>,
    ...ReturnType<typeof t.Literal<string>>[],
  ],
);

export const questV2CompletionConfirmationResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({
    confirmed: t.Literal(true),
    confirmedAt: t.String({ format: 'date-time' }),
    questStatus: questV2State,
  }),
});

export type QuestV2ProofSubmissionParams = Static<typeof questV2ProofSubmissionParamsSchema>;
export type QuestV2ProofSubmissionDetailParams = Static<typeof questV2ProofSubmissionDetailParamsSchema>;
export type QuestV2ProofSubmissionCreateInput = Static<typeof questV2ProofSubmissionCreateSchema>;
export type QuestV2ProofSubmissionEditInput = Static<typeof questV2ProofSubmissionEditSchema>;
