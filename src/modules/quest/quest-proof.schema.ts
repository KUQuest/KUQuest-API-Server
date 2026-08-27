import { t } from 'elysia';

import { proofStatuses } from './quest.contract';

const statusSchema = t.Union(proofStatuses.map((value) => t.Literal(value)) as [ReturnType<typeof t.Literal<string>>, ...ReturnType<typeof t.Literal<string>>[]]);
const fileIdsSchema = t.Array(t.String({ format: 'uuid' }), { maxItems: 3 });

export const proofParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }) });
export const proofDetailParamsSchema = t.Object({ questId: t.String({ format: 'uuid' }), proofId: t.String({ format: 'uuid' }) });
export const proofSubmitSchema = t.Object({
  content: t.String({ minLength: 1, maxLength: 5000, pattern: '\\S' }),
  fileIds: t.Optional(fileIdsSchema),
  imageIds: t.Optional(fileIdsSchema),
  images: t.Optional(t.Files({ maxItems: 3 })),
}, { additionalProperties: false });
export const proofConfirmationSchema = t.Object({}, { additionalProperties: false });
export const proofReviewSchema = t.Object({
  status: t.Union([t.Literal('PROOF_APPROVED'), t.Literal('PROOF_REJECTED')]),
  reviewNote: t.Optional(t.Nullable(t.String({ maxLength: 1000 }))),
}, { additionalProperties: false });

const proofSchema = t.Object({
  id: t.String({ format: 'uuid' }),
  questId: t.String({ format: 'uuid' }),
  workerId: t.Nullable(t.String({ format: 'uuid' })),
  teamId: t.Nullable(t.String({ format: 'uuid' })),
  submittedByUserId: t.String({ format: 'uuid' }),
  content: t.String(),
  submissionStatus: statusSchema,
  reviewNote: t.Nullable(t.String()),
  submittedAt: t.String({ format: 'date-time' }),
  reviewedAt: t.Nullable(t.String({ format: 'date-time' })),
  images: t.Array(t.String({ format: 'uuid' })),
});
export const proofResponseSchema = t.Object({ success: t.Literal(true), data: proofSchema });
export const proofListResponseSchema = t.Object({ success: t.Literal(true), data: t.Object({ items: t.Array(proofSchema) }) });
export const proofReviewResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ proof: proofSchema, questStatus: t.String() }),
});
export const proofConfirmationResponseSchema = t.Object({
  success: t.Literal(true),
  data: t.Object({ confirmed: t.Boolean(), questStatus: t.String() }),
});

export type ProofSubmitInput = typeof proofSubmitSchema.static;
export type ProofReviewInput = typeof proofReviewSchema.static;
