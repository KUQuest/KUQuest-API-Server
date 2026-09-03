import type { AuthedContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import {
  UnsupportedWorkChatAttachmentError,
  WorkChatAttachmentTooLargeError,
  WorkChatAttachmentUploadError,
} from '@/modules/work-chat/work-chat.storage';
import { apiError, apiSuccess } from '@/shared/api-response';

import type {
  QuestV2ProofSubmissionCreateInput,
  QuestV2ProofSubmissionDetailParams,
  QuestV2ProofSubmissionEditInput,
  QuestV2ProofSubmissionParams,
} from './quest-proof-v2.schema';
import {
  confirmQuestV2Completion,
  createQuestV2ProofSubmission,
  deleteQuestV2ProofSubmission,
  editQuestV2ProofSubmission,
  listQuestV2ProofSubmissions,
  submitQuestV2ProofSubmission,
  type QuestV2CompletionConfirmationOutcome,
  type QuestV2ProofDraftInput,
  type QuestV2ProofFailedFile,
  type QuestV2ProofSubmission,
  type QuestV2ProofSubmissionListOutcome,
  type QuestV2ProofSubmissionOutcome,
  type StoredQuestV2ProofFileInput,
} from './quest-proof-v2.service';
import {
  questV2ProofStorage,
  type StoredQuestV2ProofFile,
} from './quest-proof-v2.storage';
import { WorkChatTransitionError } from './quest-work-chat.port';

type DraftBody = QuestV2ProofSubmissionCreateInput | QuestV2ProofSubmissionEditInput;

const serializeSubmission = (submission: QuestV2ProofSubmission) => ({
  id: submission.id,
  questId: submission.questId,
  workerId: submission.workerId,
  teamId: submission.teamId,
  submittedByUserId: submission.submittedByUserId,
  description: submission.description,
  status: submission.status,
  submittedAt: submission.submittedAt?.toISOString() ?? null,
  createdAt: submission.createdAt.toISOString(),
  updatedAt: submission.updatedAt.toISOString(),
  visibility: submission.visibility,
  fileIds: submission.fileIds,
  files: submission.files,
});

const requiredCommandId = (request: Request | undefined, set: AuthedContext['set']) => {
  const commandId = request?.headers.get('idempotency-key');
  if (commandId?.trim()) return commandId;
  set.status = 400;
  return apiError('IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
};

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

const mapCommandError = (
  set: AuthedContext['set'],
  outcome: string,
) => {
  if (outcome === 'not-found') {
    set.status = 404;
    return apiError('QUEST_NOT_FOUND', 'Quest not found');
  }
  if (outcome === 'proof-not-found') {
    set.status = 404;
    return apiError('PROOF_SUBMISSION_NOT_FOUND', 'Proof Submission not found');
  }
  if (outcome === 'not-authorized' || outcome === 'hirer-not-allowed') {
    set.status = 403;
    return apiError('PROOF_SUBMISSION_NOT_ALLOWED', 'The Member is not the required Proof submitter');
  }
  if (outcome === 'not-required') {
    return conflict(set, 'PROOF_NOT_REQUIRED', 'This Quest uses completion confirmation instead of Proof Submission');
  }
  if (outcome === 'not-in-progress') {
    return conflict(set, 'QUEST_NOT_IN_PROGRESS', 'Proof Submission commands are allowed only while the Quest is in progress');
  }
  if (outcome === 'due-at-missing') {
    return conflict(set, 'PROOF_DUE_AT_REQUIRED', 'This Quest has no Proof Submission deadline');
  }
  if (outcome === 'due-at-passed') {
    return conflict(set, 'PROOF_DUE_AT_PASSED', 'The Proof Submission deadline has passed');
  }
  if (outcome === 'already-exists') {
    return conflict(set, 'PROOF_SUBMISSION_ALREADY_EXISTS', 'The required submitter already has a Proof Submission');
  }
  if (outcome === 'already-sent' || outcome === 'submission-locked') {
    return conflict(set, 'PROOF_SUBMISSION_LOCKED', 'A sent Proof Submission cannot be changed');
  }
  if (outcome === 'already-confirmed') {
    return conflict(set, 'COMPLETION_ALREADY_CONFIRMED', 'Completion was already confirmed for this Assignment');
  }
  if (outcome === 'files-required') {
    set.status = 400;
    return apiError('PROOF_FILES_REQUIRED', 'A sent Proof Submission must contain at least one file');
  }
  if (outcome === 'files-failed') {
    return conflict(set, 'PROOF_FILES_UPLOAD_FAILED', 'Retry or remove every failed Proof file before sending');
  }
  if (outcome === 'invalid-files') {
    set.status = 400;
    return apiError('PROOF_FILES_INVALID', 'Proof files are missing, deleted, unauthorized, or invalid');
  }
  if (outcome === 'invalid-draft') {
    set.status = 400;
    return apiError('PROOF_DRAFT_INVALID', 'Add a non-blank description or at least one file');
  }
  if (outcome === 'not-v2-contract') {
    return conflict(set, 'QUEST_V2_CONTRACT_INVALID', 'The Quest does not have a valid v2 mode and participation');
  }
  if (outcome === 'idempotency-key-reused') {
    return conflict(set, 'IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was used for a different request');
  }
  if (outcome === 'idempotency-in-progress') {
    return conflict(set, 'IDEMPOTENCY_IN_PROGRESS', 'The Idempotency-Key is still processing');
  }
  if (outcome === 'idempotency-unavailable') {
    set.status = 503;
    return apiError('IDEMPOTENCY_UNAVAILABLE', 'The Idempotency-Key result is unavailable');
  }
  set.status = 400;
  return apiError('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must not be empty');
};

const fingerprintFor = async (input: File, position: number): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await input.arrayBuffer());
  const contentHash = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const requestDigest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify({
      contentHash,
      position,
      contentType: input.type,
      fileName: input.name,
      size: input.size,
    })),
  );
  return Array.from(
    new Uint8Array(requestDigest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
};

const failureCodeFor = (error: unknown): string => {
  if (error instanceof WorkChatAttachmentTooLargeError) return 'PROOF_FILE_TOO_LARGE';
  if (error instanceof UnsupportedWorkChatAttachmentError) return 'PROOF_FILE_TYPE_NOT_SUPPORTED';
  if (error instanceof WorkChatAttachmentUploadError) return 'PROOF_FILE_UPLOAD_FAILED';
  return 'PROOF_FILE_UPLOAD_FAILED';
};

const uploadFiles = async (
  memberId: string,
  files: File[] = [],
): Promise<{
  uploaded: StoredQuestV2ProofFileInput[];
  failed: QuestV2ProofFailedFile[];
  fingerprints: string[];
  error?: unknown;
}> => {
  const uploaded: StoredQuestV2ProofFileInput[] = [];
  const failed: QuestV2ProofFailedFile[] = [];
  const fingerprints: string[] = [];
  let firstError: unknown;
  for (const [position, input] of files.entries()) {
    fingerprints.push(await fingerprintFor(input, position));
    try {
      uploaded.push({
        ...(await questV2ProofStorage.upload(memberId, input)),
        position,
      });
    } catch (error) {
      failed.push({ position, failureCode: failureCodeFor(error) });
      firstError ??= error;
    }
  }
  return { uploaded, failed, fingerprints, error: firstError };
};

const cleanupUploadedFiles = async (files: StoredQuestV2ProofFile[]) => {
  await Promise.all(files.map((file) => questV2ProofStorage.remove(file).catch(() => undefined)));
};

const mapUploadError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof WorkChatAttachmentTooLargeError) {
    set.status = 413;
    return apiError('PROOF_FILE_TOO_LARGE', error.message);
  }
  if (error instanceof UnsupportedWorkChatAttachmentError) {
    set.status = 415;
    return apiError('PROOF_FILE_TYPE_NOT_SUPPORTED', error.message);
  }
  if (error instanceof WorkChatAttachmentUploadError) {
    set.status = 502;
    return apiError('PROOF_FILE_UPLOAD_FAILED', 'Proof file upload failed; the valid Draft content was preserved');
  }
  throw error;
};

const serviceInputFor = (
  body: DraftBody,
  upload: {
    uploaded: StoredQuestV2ProofFileInput[];
    failed: QuestV2ProofFailedFile[];
    fingerprints: string[];
  },
): QuestV2ProofDraftInput => {
  const input: QuestV2ProofDraftInput = {
    storedFiles: upload.uploaded,
    failedFiles: upload.failed,
    fileFingerprints: upload.fingerprints,
  };
  if (Object.prototype.hasOwnProperty.call(body, 'description')) input.description = body.description;
  if (Object.prototype.hasOwnProperty.call(body, 'fileIds')) input.fileIds = body.fileIds;
  return input;
};

const commandResult = (
  set: AuthedContext['set'],
  result: QuestV2ProofSubmissionOutcome,
) => {
  if ('outcome' in result) return mapCommandError(set, result.outcome);
  return apiSuccess(serializeSubmission(result));
};

export const createQuestV2ProofSubmissionController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & { body: QuestV2ProofSubmissionCreateInput; params: QuestV2ProofSubmissionParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  if (body.fileIds !== undefined && (body.files?.length ?? 0) > 0) {
    set.status = 400;
    return apiError('PROOF_FILES_CONFLICT', 'Use multipart files or existing file IDs, not both');
  }

  const upload = await uploadFiles(session.user.id, body.files);
  if (upload.error) {
    let persisted = false;
    if (upload.uploaded.length + upload.failed.length > 0) {
      const partial = await createQuestV2ProofSubmission(
        session.user.id,
        params.questId,
        serviceInputFor(body, upload),
        commandId,
      );
      persisted = !('outcome' in partial) && partial.replayed !== true;
    }
    if (!persisted) await cleanupUploadedFiles(upload.uploaded);
    return mapUploadError(set, upload.error);
  }

  try {
    const result = await createQuestV2ProofSubmission(
      session.user.id,
      params.questId,
      serviceInputFor(body, upload),
      commandId,
    );
    if ('outcome' in result || result.replayed === true) await cleanupUploadedFiles(upload.uploaded);
    if ('outcome' in result) return mapCommandError(set, result.outcome);
    set.status = 201;
    return apiSuccess(serializeSubmission(result));
  } catch (error) {
    await cleanupUploadedFiles(upload.uploaded);
    throw error;
  }
};

export const editQuestV2ProofSubmissionController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & { body: QuestV2ProofSubmissionEditInput; params: QuestV2ProofSubmissionDetailParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  if (body.fileIds !== undefined && (body.files?.length ?? 0) > 0) {
    set.status = 400;
    return apiError('PROOF_FILES_CONFLICT', 'Use multipart files or existing file IDs, not both');
  }
  const upload = await uploadFiles(session.user.id, body.files);
  const input = serviceInputFor(body, upload);
  if (upload.error) {
    let persisted = false;
    if (upload.uploaded.length + upload.failed.length > 0) {
      const partial = await editQuestV2ProofSubmission(
        session.user.id,
        params.questId,
        params.proofSubmissionId,
        input,
        commandId,
      );
      persisted = !('outcome' in partial) && partial.replayed !== true;
    }
    if (!persisted) await cleanupUploadedFiles(upload.uploaded);
    return mapUploadError(set, upload.error);
  }

  try {
    const result = await editQuestV2ProofSubmission(
      session.user.id,
      params.questId,
      params.proofSubmissionId,
      input,
      commandId,
    );
    if ('outcome' in result || result.replayed === true) await cleanupUploadedFiles(upload.uploaded);
    return commandResult(set, result);
  } catch (error) {
    await cleanupUploadedFiles(upload.uploaded);
    throw error;
  }
};

export const deleteQuestV2ProofSubmissionController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofSubmissionDetailParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await deleteQuestV2ProofSubmission(
    session.user.id,
    params.questId,
    params.proofSubmissionId,
    commandId,
  );
  if ('outcome' in result) return mapCommandError(set, result.outcome);
  return apiSuccess(result);
};

export const submitQuestV2ProofSubmissionController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofSubmissionDetailParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await submitQuestV2ProofSubmission(
    session.user.id,
    params.questId,
    params.proofSubmissionId,
    commandId,
  );
  return commandResult(set, result);
};

export const listQuestV2ProofSubmissionsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofSubmissionParams }) => {
  const result: QuestV2ProofSubmissionListOutcome = await listQuestV2ProofSubmissions(
    session.user.id,
    params.questId,
  );
  if ('outcome' in result) {
    set.status = 404;
    return apiError(
      result.outcome === 'not-found' ? 'QUEST_NOT_FOUND' : 'PROOF_SUBMISSION_NOT_ALLOWED',
      result.outcome === 'not-found' ? 'Quest not found' : 'The Member cannot read this Quest Proof list',
    );
  }
  return apiSuccess({ items: result.map(serializeSubmission) });
};

export const confirmQuestV2CompletionController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofSubmissionParams }) => {
  const commandId = requiredCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  let result: QuestV2CompletionConfirmationOutcome;
  try {
    result = await confirmQuestV2Completion(
      session.user.id,
      params.questId,
      commandId,
    );
  } catch (error) {
    if (error instanceof MoneyDomainError || error instanceof WorkChatTransitionError) {
      set.status = 503;
      return apiError('QUEST_COMPLETION_UNAVAILABLE', 'Quest completion could not settle its Wallet or Work Chat transition');
    }
    throw error;
  }
  if ('outcome' in result) return mapCommandError(set, result.outcome);
  return apiSuccess({
    confirmed: result.confirmed,
    confirmedAt: result.confirmedAt.toISOString(),
    questStatus: result.questStatus,
  });
};
