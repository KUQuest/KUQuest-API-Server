import type { AuthedContext } from '@/modules/auth';
import { MoneyDomainError } from '@/modules/wallet';
import { apiError, apiSuccess } from '@/shared/api-response';
import {
  FileLinkUnavailableError,
  FileTooLargeError,
  FileUploadError,
  UnsupportedFileTypeError,
} from '@/shared/object-storage';

import { mapQuestCommandOutcome, requireQuestCommandId } from '../../quest-command.controller';
import type { QuestCommandOutcomeCode } from '../../quest-command.service';
import type {
  QuestV2ProofFileParams,
  QuestV2ProofSubmissionCreateInput,
  QuestV2ProofSubmissionDetailParams,
  QuestV2ProofSubmissionEditInput,
  QuestV2ProofSubmissionParams,
  QuestV2ProofSubmissionReviewInput,
} from './quest-proof-v2.schema';
import {
  confirmQuestV2Completion,
  createQuestV2ProofSubmissionWithFiles,
  deleteQuestV2ProofSubmission,
  editQuestV2ProofSubmissionWithFiles,
  getQuestV2ProofFile,
  listQuestV2ProofSubmissions,
  reviewQuestV2ProofSubmission,
  submitQuestV2ProofSubmission,
  type QuestV2CompletionConfirmationOutcome,
  type QuestV2ProofSubmission,
  type ProofCommandOutcomeCode,
  type QuestV2ProofSubmissionListOutcome,
  type QuestV2ProofSubmissionOutcome,
  type QuestV2ProofFileAccess,
} from './quest-proof-v2.service';
import { WorkChatTransitionError } from '../../quest-work-chat.port';

const serializeSubmission = (submission: QuestV2ProofSubmission) => ({
  id: submission.id,
  questId: submission.questId,
  workerId: submission.workerId,
  teamId: submission.teamId,
  submittedByUserId: submission.submittedByUserId,
  description: submission.description,
  workerMessage: submission.workerMessage,
  status: submission.status,
  submittedAt: submission.submittedAt?.toISOString() ?? null,
  createdAt: submission.createdAt.toISOString(),
  updatedAt: submission.updatedAt.toISOString(),
  visibility: submission.visibility,
  fileIds: submission.fileIds,
  files: submission.files,
});

const conflict = (set: AuthedContext['set'], code: string, message: string) => {
  set.status = 409;
  return apiError(code, message);
};

const mapCommandError = (set: AuthedContext['set'], outcome: ProofCommandOutcomeCode) => {
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
    return apiError(
      'PROOF_SUBMISSION_NOT_ALLOWED',
      'The Member is not the required Proof submitter'
    );
  }
  if (outcome === 'not-required') {
    return conflict(
      set,
      'PROOF_NOT_REQUIRED',
      'This Quest uses completion confirmation instead of Proof Submission'
    );
  }
  if (outcome === 'not-in-progress') {
    return conflict(
      set,
      'QUEST_NOT_IN_PROGRESS',
      'Proof Submission commands are allowed only while the Quest is in progress'
    );
  }
  if (outcome === 'due-at-missing') {
    return conflict(set, 'PROOF_DUE_AT_REQUIRED', 'This Quest has no Proof Submission deadline');
  }
  if (outcome === 'due-at-passed') {
    return conflict(set, 'PROOF_DUE_AT_PASSED', 'The Proof Submission deadline has passed');
  }
  if (outcome === 'already-exists') {
    return conflict(
      set,
      'PROOF_SUBMISSION_ALREADY_EXISTS',
      'The required submitter already has a Proof Submission'
    );
  }
  if (outcome === 'already-sent' || outcome === 'submission-locked') {
    return conflict(set, 'PROOF_SUBMISSION_LOCKED', 'A sent Proof Submission cannot be changed');
  }
  if (outcome === 'already-confirmed') {
    return conflict(
      set,
      'COMPLETION_ALREADY_CONFIRMED',
      'Completion was already confirmed for this Assignment'
    );
  }
  if (outcome === 'files-required') {
    set.status = 400;
    return apiError(
      'PROOF_FILES_REQUIRED',
      'A sent Proof Submission must contain at least one file'
    );
  }
  if (outcome === 'files-failed') {
    return conflict(
      set,
      'PROOF_FILES_UPLOAD_FAILED',
      'Retry or remove every failed Proof file before sending'
    );
  }
  if (outcome === 'invalid-files') {
    set.status = 400;
    return apiError(
      'PROOF_FILES_INVALID',
      'Proof files are missing, deleted, unauthorized, or invalid'
    );
  }
  if (outcome === 'invalid-draft') {
    set.status = 400;
    return apiError('PROOF_DRAFT_INVALID', 'Add a non-blank description or at least one file');
  }
  if (outcome === 'not-v2-contract') {
    return conflict(
      set,
      'QUEST_V2_CONTRACT_INVALID',
      'The Quest does not have a valid v2 mode and participation'
    );
  }
  // Review-only outcomes are mapped by reviewResult before this tail; anything
  // that reaches here past the business codes above is a Quest Command outcome.
  return mapQuestCommandOutcome(set, outcome as QuestCommandOutcomeCode);
};

const mapUploadError = (set: AuthedContext['set'], error: unknown) => {
  if (error instanceof FileTooLargeError) {
    set.status = 413;
    return apiError('PROOF_FILE_TOO_LARGE', error.message);
  }
  if (error instanceof UnsupportedFileTypeError) {
    set.status = 415;
    return apiError('PROOF_FILE_TYPE_NOT_SUPPORTED', error.message);
  }
  if (error instanceof FileUploadError) {
    set.status = 502;
    return apiError(
      'PROOF_FILE_UPLOAD_FAILED',
      'Proof file upload failed; the valid Draft content was preserved'
    );
  }
  throw error;
};

const commandResult = (set: AuthedContext['set'], result: QuestV2ProofSubmissionOutcome) => {
  if ('outcome' in result) return mapCommandError(set, result.outcome);
  return apiSuccess(serializeSubmission(result));
};

const reviewResult = (
  set: AuthedContext['set'],
  result: Awaited<ReturnType<typeof reviewQuestV2ProofSubmission>>
) => {
  if ('outcome' in result) {
    if (result.outcome === 'hirer-not-allowed') {
      set.status = 403;
      return apiError(
        'PROOF_REVIEW_NOT_ALLOWED',
        'Only the Quest Hirer can review this Proof Submission'
      );
    }
    if (result.outcome === 'proof-not-found') {
      set.status = 404;
      return apiError('PROOF_SUBMISSION_NOT_FOUND', 'Proof Submission not found');
    }
    if (result.outcome === 'proof-not-sent')
      return conflict(
        set,
        'PROOF_SUBMISSION_NOT_SENT',
        'Only a sent Proof Submission can be reviewed'
      );
    if (result.outcome === 'review-not-pending')
      return conflict(
        set,
        'PROOF_REVIEW_NOT_PENDING',
        'The Proof Submission already has a final decision'
      );
    if (result.outcome === 'not-reviewable')
      return conflict(
        set,
        'QUEST_NOT_REVIEWABLE',
        'The Quest does not accept a Proof review in its current state'
      );
    if (result.outcome === 'review-reason-required') {
      set.status = 400;
      return apiError(
        'PROOF_NOT_APPROVED_REASON_REQUIRED',
        'PROOF_NOT_APPROVED requires a non-blank reason'
      );
    }
    if (result.outcome === 'review-reason-invalid') {
      set.status = 400;
      return apiError('PROOF_REVIEW_REASON_INVALID', 'The Proof review reason is invalid');
    }
    if (result.outcome === 'invalid-review-decision') {
      set.status = 400;
      return apiError('PROOF_REVIEW_DECISION_INVALID', 'The Proof review decision is invalid');
    }
    if (result.outcome === 'not-required')
      return conflict(
        set,
        'PROOF_NOT_REQUIRED',
        'This Quest uses completion confirmation instead of Proof Submission'
      );
    return mapCommandError(set, result.outcome);
  }
  return apiSuccess({
    proof: serializeSubmission(result.proof),
    questStatus: result.questStatus,
  });
};

export const createQuestV2ProofSubmissionController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2ProofSubmissionCreateInput;
  params: QuestV2ProofSubmissionParams;
}) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  if (body.fileIds !== undefined && (body.files?.length ?? 0) > 0) {
    set.status = 400;
    return apiError('PROOF_FILES_CONFLICT', 'Use multipart files or existing file IDs, not both');
  }
  if (body.retryPosition !== undefined) {
    set.status = 400;
    return apiError(
      'PROOF_RETRY_POSITION_INVALID',
      'retryPosition is allowed only when editing a Proof Submission Draft'
    );
  }

  const saved = await createQuestV2ProofSubmissionWithFiles(
    session.user.id,
    params.questId,
    body,
    commandId
  );
  if ('uploadError' in saved) return mapUploadError(set, saved.uploadError);
  if ('outcome' in saved) return mapCommandError(set, saved.outcome);
  set.status = 201;
  return apiSuccess(serializeSubmission(saved));
};

export const editQuestV2ProofSubmissionController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2ProofSubmissionEditInput;
  params: QuestV2ProofSubmissionDetailParams;
}) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  if (body.fileIds !== undefined && (body.files?.length ?? 0) > 0) {
    set.status = 400;
    return apiError('PROOF_FILES_CONFLICT', 'Use multipart files or existing file IDs, not both');
  }
  if (body.retryPosition !== undefined && (body.files?.length ?? 0) !== 1) {
    set.status = 400;
    return apiError(
      'PROOF_RETRY_POSITION_INVALID',
      'retryPosition requires exactly one multipart file'
    );
  }
  if (body.retryPosition !== undefined && body.fileIds !== undefined) {
    set.status = 400;
    return apiError(
      'PROOF_RETRY_POSITION_CONFLICT',
      'retryPosition cannot be combined with existing file IDs'
    );
  }
  const saved = await editQuestV2ProofSubmissionWithFiles(
    session.user.id,
    params.questId,
    params.proofSubmissionId,
    body,
    commandId
  );
  if ('uploadError' in saved) return mapUploadError(set, saved.uploadError);
  return commandResult(set, saved);
};

export const deleteQuestV2ProofSubmissionController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofSubmissionDetailParams }) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await deleteQuestV2ProofSubmission(
    session.user.id,
    params.questId,
    params.proofSubmissionId,
    commandId
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
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  const result = await submitQuestV2ProofSubmission(
    session.user.id,
    params.questId,
    params.proofSubmissionId,
    commandId
  );
  return commandResult(set, result);
};

export const reviewQuestV2ProofSubmissionController = async ({
  body,
  params,
  request,
  session,
  set,
}: AuthedContext & {
  body: QuestV2ProofSubmissionReviewInput;
  params: QuestV2ProofSubmissionDetailParams;
}) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  let result: Awaited<ReturnType<typeof reviewQuestV2ProofSubmission>>;
  try {
    result = await reviewQuestV2ProofSubmission(
      session.user.id,
      params.questId,
      params.proofSubmissionId,
      body.decision,
      body.reason ?? null,
      commandId
    );
  } catch (error) {
    if (error instanceof WorkChatTransitionError) {
      set.status = 503;
      return apiError('WORK_CHAT_UNAVAILABLE', 'Work Chat membership could not be updated');
    }
    if (error instanceof MoneyDomainError) {
      set.status = 503;
      return apiError(
        'QUEST_SETTLEMENT_UNAVAILABLE',
        'Quest Reward settlement could not be completed'
      );
    }
    throw error;
  }
  return reviewResult(set, result);
};

export const listQuestV2ProofSubmissionsController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofSubmissionParams }) => {
  const result: QuestV2ProofSubmissionListOutcome = await listQuestV2ProofSubmissions(
    session.user.id,
    params.questId
  );
  if ('outcome' in result) {
    set.status = 404;
    return apiError(
      result.outcome === 'not-found' ? 'QUEST_NOT_FOUND' : 'PROOF_SUBMISSION_NOT_ALLOWED',
      result.outcome === 'not-found'
        ? 'Quest not found'
        : 'The Member cannot read this Quest Proof list'
    );
  }
  return apiSuccess({ items: result.map(serializeSubmission) });
};
export const getQuestV2ProofFileController = async ({
  params,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofFileParams }) => {
  let result: QuestV2ProofFileAccess | undefined;
  try {
    result = await getQuestV2ProofFile(
      session.user.id,
      params.questId,
      params.proofSubmissionId,
      params.fileId
    );
  } catch (error) {
    if (error instanceof FileLinkUnavailableError) {
      set.status = 503;
      return apiError('PROOF_FILE_LINK_UNAVAILABLE', 'Proof file link could not be created');
    }
    throw error;
  }
  if (!result) {
    set.status = 404;
    return apiError('PROOF_FILE_NOT_FOUND', 'Proof file not found');
  }
  return apiSuccess(result);
};

export const confirmQuestV2CompletionController = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & { params: QuestV2ProofSubmissionParams }) => {
  const commandId = requireQuestCommandId(request, set);
  if (typeof commandId !== 'string') return commandId;
  let result: QuestV2CompletionConfirmationOutcome;
  try {
    result = await confirmQuestV2Completion(session.user.id, params.questId, commandId);
  } catch (error) {
    if (error instanceof MoneyDomainError || error instanceof WorkChatTransitionError) {
      set.status = 503;
      return apiError(
        'QUEST_COMPLETION_UNAVAILABLE',
        'Quest completion could not settle its Wallet or Work Chat transition'
      );
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
