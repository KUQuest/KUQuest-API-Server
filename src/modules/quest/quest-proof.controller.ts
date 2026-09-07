import type { AuthedContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import {
  ImageTooLargeError,
  ImageUploadError,
  UnsupportedImageTypeError,
} from '@/shared/image-storage';
import type { Static } from 'elysia';

import { WorkChatTransitionError } from './quest-assignment.service';
import {
  autoApproveDueProofs,
  confirmProofFreeWork,
  listProofs,
  reviewProof,
  submitProof,
} from './quest-proof.service';
import type { proofDetailParamsSchema, proofParamsSchema, proofReviewSchema, proofSubmitSchema } from './quest-proof.schema';
import { proofStorage } from './quest-proof.storage';

const serialize = (row: { submittedAt: Date; reviewedAt: Date | null; [key: string]: unknown }) => ({
  ...row,
  submittedAt: row.submittedAt.toISOString(),
  reviewedAt: row.reviewedAt?.toISOString() ?? null,
});

const failure = (set: AuthedContext['set'], outcome: string) => {
  const notFound = new Set(['not-found']);
  if (notFound.has(outcome)) {
    set.status = 404;
    return apiError('PROOF_NOT_FOUND', 'Proof Submission not found');
  }
  set.status = 409;
  const messages: Record<string, [string, string]> = {
    'not-allowed': ['PROOF_NOT_ALLOWED', 'You are not an active Worker for this Quest'],
    'invalid-state': ['QUEST_NOT_IN_PROGRESS', 'The Quest is not accepting proof'],
    'invalid-review-state': ['QUEST_NOT_IN_REVIEW', 'The Quest is not in the proof review lifecycle'],
    'already-submitted': ['PROOF_ALREADY_SUBMITTED', 'This proof obligation already has a pending or approved submission'],
    'files-invalid': ['PROOF_FILES_INVALID', 'One or more proof images are missing, deleted, or unauthorized'],
    'proof-required': ['PROOF_NOT_REQUIRED', 'This Quest requires a completion confirmation instead'],
    'not-pending': ['PROOF_NOT_PENDING', 'Only a pending Proof Submission can be reviewed'],
    'no-rework': ['PROOF_REWORK_NOT_ALLOWED', 'This rejected proof cannot be resubmitted'],
  };
  const [code, message] = messages[outcome] ?? ['PROOF_COMMAND_REJECTED', 'The Proof Submission command was rejected'];
  return apiError(code, message);
};

export const submitProofController = async ({ body, params, session, set }: AuthedContext & { body: Static<typeof proofSubmitSchema>; params: Static<typeof proofParamsSchema> }) => {
  const uploaded = [];
  try {
    for (const image of body.images ?? []) uploaded.push(await proofStorage.upload(session.user.id, image));
    const hasExistingFileIds = body.fileIds !== undefined || body.imageIds !== undefined;
    if (uploaded.length > 0 && hasExistingFileIds) {
      await Promise.all(uploaded.map((image) => proofStorage.delete(image.bucket, image.objectKey).catch(() => undefined)));
      set.status = 400;
      return apiError('PROOF_FILES_CONFLICT', 'Use multipart images or existing file IDs, not both');
    }
    if (body.fileIds !== undefined && body.imageIds !== undefined) {
      await Promise.all(uploaded.map((image) => proofStorage.delete(image.bucket, image.objectKey).catch(() => undefined)));
      set.status = 400;
      return apiError('PROOF_FILES_CONFLICT', 'Use one existing file ID field');
    }
    const result = await submitProof(session.user.id, params.questId, body.content, uploaded.length > 0 ? [] : body.fileIds ?? body.imageIds ?? [], new Date(), uploaded);
    if ('outcome' in result) {
      await Promise.all(uploaded.map((image) => proofStorage.delete(image.bucket, image.objectKey).catch(() => undefined)));
      return failure(set, result.outcome);
    }
    return apiSuccess(serialize(result.proof));
  } catch (error) {
    await Promise.all(uploaded.map((image) => proofStorage.delete(image.bucket, image.objectKey).catch(() => undefined)));
    if (error instanceof ImageTooLargeError) {
      set.status = 413;
      return apiError('IMAGE_TOO_LARGE', error.message);
    }
    if (error instanceof UnsupportedImageTypeError) {
      set.status = 415;
      return apiError('UNSUPPORTED_IMAGE_TYPE', error.message);
    }
    if (error instanceof ImageUploadError) {
      set.status = 502;
      return apiError('IMAGE_UPLOAD_FAILED', 'Image upload failed');
    }
    throw error;
  }
};

export const confirmProofFreeWorkController = async ({ params, session, set }: AuthedContext & { params: Static<typeof proofParamsSchema> }) => {
  const result = await confirmProofFreeWork(session.user.id, params.questId);
  if ('outcome' in result) return failure(set, result.outcome);
  return apiSuccess(result);
};

export const listProofsController = async ({ params, session }: AuthedContext & { params: Static<typeof proofParamsSchema> }) => apiSuccess({ items: (await listProofs(session.user.id, params.questId)).map(serialize) });

export const reviewProofController = async ({ body, params, session, set }: AuthedContext & { body: Static<typeof proofReviewSchema>; params: Static<typeof proofDetailParamsSchema> }) => {
  let result: Awaited<ReturnType<typeof reviewProof>>;
  try {
    result = await reviewProof(session.user.id, params.questId, params.proofId, body.status, body.reviewNote ?? null);
  } catch (error) {
    if (error instanceof WorkChatTransitionError) {
      set.status = 503;
      return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated');
    }
    if (error instanceof MoneyDomainError) {
      set.status = 503;
      return apiError('QUEST_SETTLEMENT_UNAVAILABLE', 'Quest settlement could not be completed');
    }
    throw error;
  }
  if ('outcome' in result) {
    if (result.outcome === 'not-authorized') return failure(set, 'not-found');
    return failure(set, result.outcome);
  }
  return apiSuccess({ proof: serialize(result.proof), questStatus: result.questStatus });
};

/** Worker entry point. The process that calls this owns scheduling. */
export const autoApproveDueProofsController = async () => apiSuccess({ proofIds: await autoApproveDueProofs(new Date()) });
