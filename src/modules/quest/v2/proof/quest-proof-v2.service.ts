import { db } from '@/database/client';
import { notifyQuestUpdate } from '@/modules/quest/v2/realtime';
import { adminReviewItem } from '@/database/schema/admin.schema';
import { file } from '@/database/schema/file.schema';
import { recordAudit, type AuditActor } from '@/modules/audit/audit.service';
import { enqueuePushDeliveryInTransaction } from '@/modules/push';
import {
  quest,
  questApiVersion,
  questAssignment,
  questCandidateTeamV2,
  questCandidateTeamV2Member,
  questV2CompletionConfirmation,
  questV2ProofSubmission,
  questV2ProofSubmissionFile,
} from '@/database/schema/quest.schema';
import {
  FileDimensionsTooLargeError,
  FileLinkUnavailableError,
  FileTooLargeError,
  FileUploadError,
  UnsupportedFileTypeError,
} from '@/shared/object-storage';

import { and, asc, eq, inArray, isNull, isNotNull, lte, ne, or } from 'drizzle-orm';

import type { QuestTransaction } from '../../shared/work-chat/quest-work-chat.port';
import {
  enqueueProofNotApprovedPush,
  enqueueQuestCompletedDisputeWindowPush,
  enqueueQuestFailedPush,
} from '../lifecycle/quest-failed-v2.push';
import {
  completeQuestCommand,
  findOpenQuestCommandPayloads,
  openQuestCommand,
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from '../../shared/command/quest-command.service';

import {
  failQuestV2InTransaction,
  markAssignmentIncompleteV2InTransaction,
  settleApprovedQuestV2ProofInTransaction,
  settleProofFreeQuestV2InTransaction,
} from '../../settlement';
import {
  questV2Mode,
  questV2Participation,
  questV2States,
  type QuestV2State,
} from '../core/quest-v2.contract';
import { questV2ProofStorage, type StoredQuestV2ProofFile } from './quest-proof-v2.storage';

export const questV2ProofSubmissionOperationScope = 'quest.v2.proof-submission';

const maxDescriptionLength = 1000;
const maxWorkerMessageLength = 200;
const maxProofFiles = 5;
const maxAttachmentSizeBytes = 10 * 1024 * 1024;
const allowedAttachmentContentTypes = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
const proofStatuses = ['PROOF_PENDING', 'PROOF_APPROVED', 'PROOF_NOT_APPROVED'] as const;

/** Pending Proof Submissions auto-approve this long after submission (rulebook). */
const proofAutoApprovalWindowMs = 24 * 60 * 60 * 1000;
/** Pending proof-free completion confirmations auto-approve after this window. */
const completionAutoApprovalWindowMs = 24 * 60 * 60 * 1000;

export type QuestV2ProofStatus = (typeof proofStatuses)[number];

export type QuestV2ProofSubmission = {
  id: string;
  questId: string;
  workerId: string | null;
  teamId: string | null;
  submittedByUserId: string;
  description: string | null;
  workerMessage: string | null;
  status: QuestV2ProofStatus | null;
  submittedAt: Date | null;
  /** Exact instant the auto-approval job acts; non-null only while PROOF_PENDING. */
  reviewDeadlineAt: Date | null;
  /** Hirer's reason; visible only with FULL visibility. */
  reviewReason: string | null;
  reviewedAt: Date | null;
  reviewedBy: 'HIRER' | 'AUTO_APPROVE' | null;
  createdAt: Date;
  updatedAt: Date;
  visibility: 'FULL' | 'SUMMARY';
  fileIds: string[];
  files: Array<{
    fileId: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    position: number;
    uploadStatus: 'PROOF_FILE_READY' | 'PROOF_FILE_FAILED';
    failureCode: string | null;
    url?: string | null;
    urlExpiresAt?: string | null;
  }>;
  /** Internal marker used by the module to clean up replay-only uploads. */
  replayed?: boolean;
};

export type StoredQuestV2ProofFileInput = StoredQuestV2ProofFile & {
  position: number;
};

export type QuestV2ProofFailedFile = {
  position: number;
  failureCode: string;
};

type ReadyProofFile = {
  fileId: string;
  position: number;
};

export type QuestV2ProofDraftInput = {
  description?: string | null;
  workerMessage?: string | null;
  fileIds?: string[];
  storedFiles?: StoredQuestV2ProofFileInput[];
  failedFiles?: QuestV2ProofFailedFile[];
  fileFingerprints?: string[];
  retryPosition?: number;
};

type QuestV2ProofDraftBody = {
  description?: string | null;
  workerMessage?: string | null;
  files?: File[];
  fileIds?: string[];
  retryPosition?: number;
};

type ProofOwner = {
  workerId: string | null;
  teamId: string | null;
};

type QuestV2ProofBusinessOutcomeCode =
  | 'already-confirmed'
  | 'already-exists'
  | 'already-sent'
  | 'completion-confirmation-not-found'
  | 'completion-confirmation-review-not-pending'
  | 'due-at-missing'
  | 'due-at-passed'
  | 'files-failed'
  | 'files-required'
  | 'hirer-not-allowed'
  | 'invalid-draft'
  | 'invalid-files'
  | 'invalid-review-decision'
  | 'not-authorized'
  | 'not-found'
  | 'not-in-progress'
  | 'not-required'
  | 'not-reviewable'
  | 'proof-not-found'
  | 'proof-not-sent'
  | 'review-not-pending'
  | 'review-reason-invalid'
  | 'review-reason-required'
  | 'completion-review-reason-required'
  | 'completion-review-reason-invalid'
  | 'submission-locked'
  | 'not-v2-contract';

export type ProofCommandOutcomeCode = QuestV2ProofBusinessOutcomeCode | QuestCommandOutcomeCode;

export type QuestV2ProofSubmissionOutcome =
  QuestV2ProofSubmission | { outcome: ProofCommandOutcomeCode };

export type QuestV2ProofSubmissionDeleteOutcome =
  { deleted: true; proofSubmissionId: string } | { outcome: ProofCommandOutcomeCode };

export type QuestV2CompletionConfirmation = {
  id: string;
  confirmed: true;
  confirmedAt: Date;
  reviewDeadlineAt: Date;
  reviewStatus: QuestV2CompletionConfirmationStatus;
  questStatus: QuestV2State;
};

export type QuestV2CompletionConfirmationStatus =
  | 'COMPLETION_CONFIRMATION_PENDING'
  | 'COMPLETION_CONFIRMATION_APPROVED'
  | 'COMPLETION_CONFIRMATION_NOT_APPROVED'
  | 'COMPLETION_CONFIRMATION_CANCELLED';

export type QuestV2CompletionConfirmationReviewDecision =
  'COMPLETION_CONFIRMATION_APPROVED' | 'COMPLETION_CONFIRMATION_NOT_APPROVED';

export type QuestV2CompletionConfirmationReview = {
  confirmation: QuestV2CompletionConfirmationRecord;
  questStatus: QuestV2State;
  replayed?: boolean;
};

export type QuestV2CompletionConfirmationRecord = {
  id: string;
  questId: string;
  workerId: string | null;
  teamId: string | null;
  confirmedByUserId: string;
  confirmedAt: Date;
  reviewStatus: QuestV2CompletionConfirmationStatus;
  reviewDeadlineAt: Date | null;
  reviewReason: string | null;
  reviewedAt: Date | null;
  reviewedBy: 'HIRER' | 'AUTO_APPROVE' | null;
};

export type QuestV2CompletionConfirmationOutcome =
  QuestV2CompletionConfirmation | { outcome: ProofCommandOutcomeCode };

export type QuestV2CompletionConfirmationReviewOutcome =
  QuestV2CompletionConfirmationReview | { outcome: ProofCommandOutcomeCode };

export type QuestV2CompletionConfirmationListOutcome =
  QuestV2CompletionConfirmationRecord[] | { outcome: 'not-authorized' | 'not-found' };

export type QuestV2ProofSubmissionListOutcome =
  QuestV2ProofSubmission[] | { outcome: 'not-authorized' | 'not-found' };

export type QuestV2ProofReviewDecision = 'PROOF_APPROVED' | 'PROOF_NOT_APPROVED';

export type QuestV2ProofReview = {
  proof: QuestV2ProofSubmission;
  questStatus: QuestV2State;
  replayed?: boolean;
};

export type QuestV2ProofReviewOutcome = QuestV2ProofReview | { outcome: ProofCommandOutcomeCode };

type QuestRow = {
  hirerId: string;
  v2Mode: string | null;
  v2Participation: string | null;
  questState: string;
  proofRequired: boolean;
  dueAt: Date | null;
};

type SubmissionRow = {
  id: string;
  questId: string;
  workerId: string | null;
  teamId: string | null;
  submittedByUserId: string;
  description: string | null;
  workerMessage: string | null;
  submissionStatus: string | null;
  sentAt: Date | null;
  reviewReason: string | null;
  reviewedAt: Date | null;
  reviewedBy: 'HIRER' | 'AUTO_APPROVE' | null;
  createdAt: Date;
  updatedAt: Date;
};

const submissionFields = {
  id: questV2ProofSubmission.id,
  questId: questV2ProofSubmission.questId,
  workerId: questV2ProofSubmission.workerId,
  teamId: questV2ProofSubmission.teamId,
  submittedByUserId: questV2ProofSubmission.submittedByUserId,
  description: questV2ProofSubmission.description,
  workerMessage: questV2ProofSubmission.workerMessage,
  submissionStatus: questV2ProofSubmission.submissionStatus,
  sentAt: questV2ProofSubmission.sentAt,
  reviewReason: questV2ProofSubmission.reviewReason,
  reviewedAt: questV2ProofSubmission.reviewedAt,
  reviewedBy: questV2ProofSubmission.reviewedBy,
  createdAt: questV2ProofSubmission.createdAt,
  updatedAt: questV2ProofSubmission.updatedAt,
};

const questV2ProofCreateOperationScope = 'quest.v2.proof.create';
const questV2ProofEditOperationScope = 'quest.v2.proof.edit';
const questV2ProofDeleteOperationScope = 'quest.v2.proof.delete';
const questV2ProofSubmitOperationScope = 'quest.v2.proof.submit';
const questV2ProofReviewOperationScope = 'quest.v2.proof.review';
const questV2ProofAutoApprovalOperationScope = 'quest.v2.proof.auto-approval';
const questV2CompletionConfirmationOperationScope = 'quest.v2.proof.completion-confirmation';
const questV2CompletionConfirmationReviewOperationScope = 'quest.v2.proof.completion-review';
const questV2CompletionConfirmationAutoApprovalOperationScope =
  'quest.v2.proof.completion-auto-approval';
const questV2ProofUploadCleanupOperationScope = 'quest.v2.proof.upload-cleanup';

type QuestV2ProofUploadCleanupObject = Pick<StoredQuestV2ProofFile, 'bucket' | 'objectKey'>;

type QuestV2ProofUploadCleanupManifest = {
  cleanup: {
    objects: QuestV2ProofUploadCleanupObject[];
  };
};

export class QuestV2ProofUploadCleanupUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Proof file cleanup retry could not be recorded', { cause });
    this.name = 'QuestV2ProofUploadCleanupUnavailableError';
  }
}

const toQuestV2ProofUploadCleanupManifest = (
  objects: QuestV2ProofUploadCleanupObject[]
): QuestV2ProofUploadCleanupManifest => ({
  cleanup: {
    objects: objects.map(({ bucket, objectKey }) => ({ bucket, objectKey })),
  },
});

const fromQuestV2ProofUploadCleanupManifest = (
  value: unknown
): QuestV2ProofUploadCleanupManifest | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cleanup = (value as { cleanup?: unknown }).cleanup;
  if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) return undefined;
  const objects = (cleanup as { objects?: unknown }).objects;
  if (
    !Array.isArray(objects) ||
    objects.length === 0 ||
    objects.some((object) => {
      if (!object || typeof object !== 'object' || Array.isArray(object)) return true;
      const objectValue = object as Partial<QuestV2ProofUploadCleanupObject>;
      return (
        typeof objectValue.bucket !== 'string' ||
        objectValue.bucket.trim().length === 0 ||
        typeof objectValue.objectKey !== 'string' ||
        objectValue.objectKey.trim().length === 0
      );
    })
  )
    return undefined;
  return {
    cleanup: {
      objects: objects as QuestV2ProofUploadCleanupObject[],
    },
  };
};

export const recordQuestV2ProofUploadCleanup = async (
  memberId: string,
  questId: string,
  objects: QuestV2ProofUploadCleanupObject[],
  now = new Date()
): Promise<void> => {
  if (objects.length === 0) return;
  try {
    await openQuestCommand({
      executor: db,
      identity: {
        principalUserId: memberId,
        operationScope: questV2ProofUploadCleanupOperationScope,
        key: `quest-v2-proof-upload-cleanup:${crypto.randomUUID()}`,
        requestHash: await sha256Json({ memberId, questId, objects }),
        questId,
      },
      payload: toQuestV2ProofUploadCleanupManifest(objects),
      now,
    });
  } catch (cause) {
    throw new QuestV2ProofUploadCleanupUnavailableError(cause);
  }
};

export const retryQuestV2ProofUploadCleanup = async (limit = 100): Promise<number> => {
  const pending = await findOpenQuestCommandPayloads({
    executor: db,
    operationScope: questV2ProofUploadCleanupOperationScope,
    limit,
  });

  let retried = 0;
  for (const record of pending) {
    const manifest = fromQuestV2ProofUploadCleanupManifest(record.payload);
    if (!manifest) continue;
    let failed = false;
    for (const object of manifest.cleanup.objects) {
      try {
        await questV2ProofStorage.delete(object.bucket, object.objectKey);
      } catch (error) {
        failed = true;
        console.error('[quest-proof-upload-cleanup] Object deletion failed', {
          error,
          commandId: record.id,
          bucket: object.bucket,
          objectKey: object.objectKey,
        });
      }
    }
    if (failed) continue;
    const completed = await completeQuestCommand({
      executor: db,
      id: record.id,
      payload: { cleanup: { objects: [] } },
      now: new Date(),
    });
    if (completed) retried += 1;
  }
  return retried;
};

const fingerprintFor = async (input: File, position: number): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', await input.arrayBuffer());
  const contentHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const requestDigest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify({
        contentHash,
        position,
        contentType: input.type,
        fileName: input.name,
        size: input.size,
      })
    )
  );
  return Array.from(new Uint8Array(requestDigest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
};

const failureCodeFor = (error: unknown): string => {
  if (error instanceof FileTooLargeError) return 'PROOF_FILE_TOO_LARGE';
  if (error instanceof FileDimensionsTooLargeError) return 'PROOF_FILE_DIMENSIONS_TOO_LARGE';
  if (error instanceof UnsupportedFileTypeError) return 'PROOF_FILE_TYPE_NOT_SUPPORTED';
  if (error instanceof FileUploadError) return 'PROOF_FILE_UPLOAD_FAILED';
  return 'PROOF_FILE_UPLOAD_FAILED';
};

const uploadFiles = async (
  memberId: string,
  files: File[] = [],
  retryPosition?: number
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
    const targetPosition = retryPosition ?? position;
    fingerprints.push(await fingerprintFor(input, targetPosition));
    try {
      uploaded.push({
        ...(await questV2ProofStorage.upload(memberId, input)),
        position: targetPosition,
      });
    } catch (error) {
      failed.push({ position: targetPosition, failureCode: failureCodeFor(error) });
      firstError ??= error;
    }
  }
  return { uploaded, failed, fingerprints, error: firstError };
};

const cleanupUploadedFiles = async (
  memberId: string,
  questId: string,
  files: StoredQuestV2ProofFile[]
) => {
  const failed: StoredQuestV2ProofFile[] = [];
  await Promise.all(
    files.map(async (storedFile) => {
      try {
        await questV2ProofStorage.delete(storedFile.bucket, storedFile.objectKey);
      } catch (error) {
        failed.push(storedFile);
        console.error('[quest-proof-upload-cleanup] Immediate object deletion failed', {
          error,
          bucket: storedFile.bucket,
          objectKey: storedFile.objectKey,
        });
      }
    })
  );
  if (failed.length > 0) await recordQuestV2ProofUploadCleanup(memberId, questId, failed);
};

const draftInputFor = (
  body: QuestV2ProofDraftBody,
  upload: {
    uploaded: StoredQuestV2ProofFileInput[];
    failed: QuestV2ProofFailedFile[];
    fingerprints: string[];
  }
): QuestV2ProofDraftInput => {
  const input: QuestV2ProofDraftInput = {
    storedFiles: upload.uploaded,
    failedFiles: upload.failed,
    fileFingerprints: upload.fingerprints,
  };
  if (Object.prototype.hasOwnProperty.call(body, 'description'))
    input.description = body.description;
  if (Object.prototype.hasOwnProperty.call(body, 'workerMessage'))
    input.workerMessage = body.workerMessage;
  if (Object.prototype.hasOwnProperty.call(body, 'fileIds')) input.fileIds = body.fileIds;
  if (body.retryPosition !== undefined) input.retryPosition = body.retryPosition;
  return input;
};

const isProofStatus = (value: string | null): value is QuestV2ProofStatus =>
  value !== null && proofStatuses.includes(value as QuestV2ProofStatus);

const isQuestV2State = (value: string): value is QuestV2State =>
  questV2States.includes(value as QuestV2State);

const completionConfirmationStatuses: QuestV2CompletionConfirmationStatus[] = [
  'COMPLETION_CONFIRMATION_PENDING',
  'COMPLETION_CONFIRMATION_APPROVED',
  'COMPLETION_CONFIRMATION_NOT_APPROVED',
  'COMPLETION_CONFIRMATION_CANCELLED',
];

const isCompletionConfirmationStatus = (
  value: unknown
): value is QuestV2CompletionConfirmationStatus =>
  typeof value === 'string' &&
  completionConfirmationStatuses.includes(value as QuestV2CompletionConfirmationStatus);

const isInputFieldPresent = <T extends object, K extends keyof T>(input: T, field: K): boolean =>
  Object.prototype.hasOwnProperty.call(input, field);

const normalizedDescription = (
  value: string | null | undefined
): { value: string | null } | { outcome: 'invalid-draft' } => {
  if (value === undefined || value === null) return { value: value ?? null };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxDescriptionLength) {
    return { outcome: 'invalid-draft' };
  }
  return { value: trimmed };
};
const normalizedWorkerMessage = (
  value: string | null | undefined
): { value: string | null } | { outcome: 'invalid-draft' } => {
  if (value === undefined || value === null) return { value: value ?? null };
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxWorkerMessageLength) {
    return { outcome: 'invalid-draft' };
  }
  return { value: trimmed };
};

const lockQuest = async (
  transaction: QuestTransaction,
  questId: string
): Promise<QuestRow | undefined> => {
  const [current] = await transaction
    .select({
      hirerId: quest.hirerId,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questState: quest.questStatus,
      proofRequired: quest.proofRequired,
      dueAt: quest.dueAt,
    })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

const proofParticipantIds = async (
  transaction: QuestTransaction,
  submission: Pick<SubmissionRow, 'workerId' | 'teamId'>
): Promise<string[]> => {
  if (!submission.teamId) return submission.workerId ? [submission.workerId] : [];
  const members = await transaction
    .select({ memberId: questCandidateTeamV2Member.memberId })
    .from(questCandidateTeamV2Member)
    .where(eq(questCandidateTeamV2Member.teamId, submission.teamId));
  return members.map(({ memberId }) => memberId);
};

const activeAssignmentWorkerIds = async (
  transaction: QuestTransaction,
  questId: string
): Promise<string[]> => {
  const assignments = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    );
  return assignments.map(({ workerId }) => workerId);
};

const assignmentsWithStatus = (
  transaction: QuestTransaction,
  questId: string,
  statuses: ('ASSIGNMENT_ACTIVE' | 'ASSIGNMENT_INCOMPLETE')[]
) =>
  transaction
    .select({ assignmentId: questAssignment.id, workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(
      and(eq(questAssignment.questId, questId), inArray(questAssignment.assignmentStatus, statuses))
    );

const failureRecipientWorkerIds = async (transaction: QuestTransaction, questId: string) =>
  (
    await assignmentsWithStatus(transaction, questId, [
      'ASSIGNMENT_ACTIVE',
      'ASSIGNMENT_INCOMPLETE',
    ])
  ).map(({ workerId }) => workerId);

const allQuestWorkerIds = async (
  transaction: QuestTransaction,
  questId: string
): Promise<string[]> => {
  const assignments = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        ne(questAssignment.assignmentStatus, 'ASSIGNMENT_CANCELLED')
      )
    );
  return [...new Set(assignments.map(({ workerId }) => workerId))];
};

const failedQuestPendingProofParticipantIds = async (
  transaction: QuestTransaction,
  questId: string,
  dueAt: Date
): Promise<string[]> => {
  const submissions = await transaction
    .select({
      workerId: questV2ProofSubmission.workerId,
      teamId: questV2ProofSubmission.teamId,
    })
    .from(questV2ProofSubmission)
    .where(
      and(
        eq(questV2ProofSubmission.questId, questId),
        eq(questV2ProofSubmission.submissionStatus, 'PROOF_PENDING'),
        isNotNull(questV2ProofSubmission.sentAt),
        lte(questV2ProofSubmission.sentAt, dueAt)
      )
    );
  const members = await Promise.all(
    submissions.map((submission) => proofParticipantIds(transaction, submission))
  );
  return [...new Set(members.flat())];
};

const pendingCompletionConfirmationParticipantIds = async (
  transaction: QuestTransaction,
  questId: string,
  dueAt: Date
): Promise<string[]> => {
  const confirmations = await transaction
    .select({
      workerId: questV2CompletionConfirmation.workerId,
      teamId: questV2CompletionConfirmation.teamId,
    })
    .from(questV2CompletionConfirmation)
    .where(
      and(
        eq(questV2CompletionConfirmation.questId, questId),
        eq(questV2CompletionConfirmation.reviewStatus, 'COMPLETION_CONFIRMATION_PENDING'),
        lte(questV2CompletionConfirmation.confirmedAt, dueAt)
      )
    );
  const members = await Promise.all(
    confirmations.map((confirmation) => proofParticipantIds(transaction, confirmation))
  );
  return [...new Set(members.flat())];
};

const emitQuestUpdate = (
  transaction: QuestTransaction,
  questId: string,
  changeType:
    | 'PROOF_SUBMITTED'
    | 'PROOF_REVIEWED'
    | 'PROOF_AUTO_APPROVED'
    | 'COMPLETION_CONFIRMED'
    | 'COMPLETION_REVIEW_PENDING'
    | 'COMPLETION_REVIEWED'
    | 'QUEST_COMPLETED'
    | 'QUEST_FAILED'
    | 'DISPUTE_WINDOW_OPENED',
  recipientMemberIds: string[],
  closeMemberIds?: string[]
) =>
  notifyQuestUpdate(transaction, {
    questId,
    changeType,
    recipientMemberIds: [...new Set(recipientMemberIds)],
    ...(closeMemberIds?.length ? { closeMemberIds: [...new Set(closeMemberIds)] } : {}),
  });

const enqueueCompletionConfirmationPush = async (
  transaction: QuestTransaction,
  input: {
    recipientMemberId: string;
    questId: string;
    confirmationId: string;
    eventType: 'COMPLETION_REVIEW_PENDING' | 'COMPLETION_REVIEWED';
    decision?: QuestV2CompletionConfirmationReviewDecision;
    reviewedBy?: 'HIRER' | 'AUTO_APPROVE';
    reviewDeadlineAt?: Date;
    now: Date;
  }
) => {
  const transitionId = `quest-v2:${input.eventType}:${input.confirmationId}:${input.decision ?? 'PENDING'}`;
  await enqueuePushDeliveryInTransaction(transaction, {
    recipientMemberId: input.recipientMemberId,
    eventKey: transitionId,
    eventType: input.eventType,
    title:
      input.eventType === 'COMPLETION_REVIEW_PENDING'
        ? 'Completion confirmation needs review'
        : input.decision === 'COMPLETION_CONFIRMATION_APPROVED'
          ? input.reviewedBy === 'AUTO_APPROVE'
            ? 'Completion confirmation approved automatically'
            : 'Completion confirmation approved'
          : 'Completion confirmation not approved',
    body:
      input.eventType === 'COMPLETION_REVIEW_PENDING'
        ? 'A Worker confirmed Quest completion. Review the confirmation.'
        : input.decision === 'COMPLETION_CONFIRMATION_APPROVED'
          ? input.reviewedBy === 'AUTO_APPROVE'
            ? 'The Server approved your completion confirmation because the Hirer did not decide within 24 hours.'
            : 'The Hirer approved your completion confirmation.'
          : 'The Hirer did not approve your completion confirmation. Open the Quest to read the reason.',
    deepLink: `kuquest://quest/${input.questId}`,
    data: {
      type: input.eventType,
      questId: input.questId,
      completionConfirmationId: input.confirmationId,
      transitionId,
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.reviewedBy ? { reviewedBy: input.reviewedBy } : {}),
      ...(input.reviewDeadlineAt ? { reviewDeadlineAt: input.reviewDeadlineAt.toISOString() } : {}),
    },
    now: input.now,
  });
};

const ownerCondition = (owner: ProofOwner) =>
  owner.workerId
    ? eq(questV2ProofSubmission.workerId, owner.workerId)
    : eq(questV2ProofSubmission.teamId, owner.teamId!);

const ownerFor = async (
  transaction: QuestTransaction,
  current: QuestRow,
  questId: string,
  memberId: string
): Promise<ProofOwner | undefined> => {
  if (current.hirerId === memberId) return undefined;
  if (!current.v2Mode || !current.v2Participation) return undefined;

  if (
    current.v2Mode === questV2Mode.candidate &&
    current.v2Participation === questV2Participation.group
  ) {
    const [team] = await transaction
      .select({ id: questCandidateTeamV2.id })
      .from(questCandidateTeamV2)
      .innerJoin(
        questCandidateTeamV2Member,
        eq(questCandidateTeamV2Member.teamId, questCandidateTeamV2.id)
      )
      .where(
        and(
          eq(questCandidateTeamV2.questId, questId),
          eq(questCandidateTeamV2.leaderId, memberId),
          eq(questCandidateTeamV2Member.memberId, memberId),
          eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
        )
      )
      .limit(1)
      .for('update');
    if (!team) return undefined;

    const [assignment] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, questId),
          eq(questAssignment.workerId, memberId),
          eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
        )
      )
      .limit(1)
      .for('update');
    return assignment ? { workerId: null, teamId: team.id } : undefined;
  }

  const [assignment] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.workerId, memberId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    )
    .limit(1)
    .for('update');
  return assignment ? { workerId: memberId, teamId: null } : undefined;
};

const submissionForOwner = async (
  transaction: QuestTransaction,
  questId: string,
  owner: ProofOwner
): Promise<SubmissionRow | undefined> => {
  const [submission] = await transaction
    .select(submissionFields)
    .from(questV2ProofSubmission)
    .where(and(eq(questV2ProofSubmission.questId, questId), ownerCondition(owner)))
    .limit(1)
    .for('update');
  return submission;
};

const attachmentRowsFor = async (database: typeof db | QuestTransaction, submissionId: string) =>
  database
    .select({
      fileId: questV2ProofSubmissionFile.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: questV2ProofSubmissionFile.position,
      uploadStatus: questV2ProofSubmissionFile.uploadStatus,
      failureCode: questV2ProofSubmissionFile.failureCode,
      bucket: file.bucket,
      objectKey: file.objectKey,
      deletedAt: file.deletedAt,
    })
    .from(questV2ProofSubmissionFile)
    .leftJoin(file, eq(file.id, questV2ProofSubmissionFile.fileId))
    .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submissionId))
    .orderBy(asc(questV2ProofSubmissionFile.position));

const reviewDeadlineFor = (status: string | null, sentAt: Date | null): Date | null =>
  status === 'PROOF_PENDING' && sentAt
    ? new Date(sentAt.getTime() + proofAutoApprovalWindowMs)
    : null;

const proofFileLinkFor = (attachment: Awaited<ReturnType<typeof attachmentRowsFor>>[number]) => {
  if (
    attachment.uploadStatus !== 'PROOF_FILE_READY' ||
    attachment.fileId === null ||
    attachment.deletedAt !== null ||
    attachment.bucket === null ||
    attachment.objectKey === null
  ) {
    return { url: null, urlExpiresAt: null };
  }

  try {
    const link = questV2ProofStorage.linkForWithExpiry({
      bucket: attachment.bucket,
      objectKey: attachment.objectKey,
    });
    return { url: link.url, urlExpiresAt: link.expiresAt.toISOString() };
  } catch (error) {
    if (error instanceof FileLinkUnavailableError) return { url: null, urlExpiresAt: null };
    throw error;
  }
};

const toSubmission = async (
  database: typeof db | QuestTransaction,
  row: SubmissionRow,
  visibility: 'FULL' | 'SUMMARY' = 'FULL',
  includeFileLinks = false
): Promise<QuestV2ProofSubmission> => {
  if (row.submissionStatus !== null && !isProofStatus(row.submissionStatus)) {
    throw new Error('Quest API v2 Proof Submission has an invalid status');
  }
  const attachments = visibility === 'FULL' ? await attachmentRowsFor(database, row.id) : [];
  return {
    id: row.id,
    questId: row.questId,
    workerId: row.workerId,
    teamId: row.teamId,
    submittedByUserId: row.submittedByUserId,
    description: visibility === 'FULL' ? row.description : null,
    workerMessage: visibility === 'FULL' ? row.workerMessage : null,
    status:
      visibility === 'FULL'
        ? (row.submissionStatus as QuestV2ProofStatus | null)
        : (row.submissionStatus as QuestV2ProofStatus),
    submittedAt: row.sentAt,
    reviewDeadlineAt: reviewDeadlineFor(row.submissionStatus, row.sentAt),
    reviewReason: visibility === 'FULL' ? row.reviewReason : null,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    visibility,
    fileIds: attachments
      .filter(
        (attachment) => attachment.uploadStatus === 'PROOF_FILE_READY' && attachment.fileId !== null
      )
      .map((attachment) => attachment.fileId!),
    files: await Promise.all(
      attachments.map(async (attachment) => ({
        fileId: attachment.fileId,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        position: attachment.position,
        uploadStatus: attachment.uploadStatus,
        failureCode: attachment.failureCode,
        ...(includeFileLinks ? proofFileLinkFor(attachment) : {}),
      }))
    ),
  };
};

const snapshotFor = (submission: QuestV2ProofSubmission) => ({
  ...submission,
  submittedAt: submission.submittedAt?.toISOString() ?? null,
  reviewDeadlineAt: submission.reviewDeadlineAt?.toISOString() ?? null,
  reviewedAt: submission.reviewedAt?.toISOString() ?? null,
  createdAt: submission.createdAt.toISOString(),
  updatedAt: submission.updatedAt.toISOString(),
});

const dateFromSnapshot = (value: unknown): Date | undefined => {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

const submissionFromSnapshot = (value: unknown): QuestV2ProofSubmission | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<QuestV2ProofSubmission>;
  if (
    typeof snapshot.id !== 'string' ||
    typeof snapshot.questId !== 'string' ||
    (snapshot.workerId !== null && typeof snapshot.workerId !== 'string') ||
    (snapshot.teamId !== null && typeof snapshot.teamId !== 'string') ||
    typeof snapshot.submittedByUserId !== 'string' ||
    (snapshot.description !== null && typeof snapshot.description !== 'string') ||
    (snapshot.workerMessage !== undefined &&
      snapshot.workerMessage !== null &&
      typeof snapshot.workerMessage !== 'string') ||
    (snapshot.status !== null &&
      (typeof snapshot.status !== 'string' || !isProofStatus(snapshot.status))) ||
    (snapshot.submittedAt !== null && typeof snapshot.submittedAt !== 'string') ||
    !Array.isArray(snapshot.fileIds) ||
    !Array.isArray(snapshot.files) ||
    snapshot.visibility !== 'FULL'
  )
    return undefined;
  if (snapshot.submittedAt === undefined) return undefined;
  let submittedAt: Date | null;
  if (snapshot.submittedAt === null) {
    submittedAt = null;
  } else {
    const parsedSubmittedAt = dateFromSnapshot(snapshot.submittedAt);
    if (!parsedSubmittedAt) return undefined;
    submittedAt = parsedSubmittedAt;
  }
  const createdAt = dateFromSnapshot(snapshot.createdAt);
  const updatedAt = dateFromSnapshot(snapshot.updatedAt);
  if (!createdAt || !updatedAt) return undefined;
  return {
    id: snapshot.id,
    questId: snapshot.questId,
    workerId: snapshot.workerId,
    teamId: snapshot.teamId,
    submittedByUserId: snapshot.submittedByUserId,
    description: snapshot.description as string | null,
    workerMessage:
      snapshot.workerMessage === undefined ? null : (snapshot.workerMessage as string | null),
    status: snapshot.status as QuestV2ProofStatus | null,
    submittedAt,
    reviewDeadlineAt: reviewDeadlineFor(snapshot.status as QuestV2ProofStatus | null, submittedAt),
    reviewReason: typeof snapshot.reviewReason === 'string' ? snapshot.reviewReason : null,
    reviewedAt: dateFromSnapshot(snapshot.reviewedAt) ?? null,
    reviewedBy:
      snapshot.reviewedBy === 'HIRER' || snapshot.reviewedBy === 'AUTO_APPROVE'
        ? snapshot.reviewedBy
        : null,
    createdAt,
    updatedAt,
    visibility: 'FULL',
    fileIds: snapshot.fileIds as string[],
    files: snapshot.files as QuestV2ProofSubmission['files'],
  };
};

const reviewFromSnapshot = (value: unknown): QuestV2ProofReview | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as { proof?: unknown; questStatus?: unknown };
  const proof = submissionFromSnapshot(snapshot.proof);
  if (!proof || typeof snapshot.questStatus !== 'string' || !isQuestV2State(snapshot.questStatus)) {
    return undefined;
  }
  return {
    proof: { ...proof, replayed: true },
    questStatus: snapshot.questStatus,
    replayed: true,
  };
};

const requestHashFor = (
  memberId: string,
  operation: string,
  questId: string,
  proofSubmissionId: string | null,
  input: QuestV2ProofDraftInput | null
): Promise<string> =>
  sha256Json({
    authenticatedMemberId: memberId,
    operation,
    path: proofSubmissionId
      ? '/api/v2/quests/:questId/proof-submissions/:proofSubmissionId'
      : '/api/v2/quests/:questId/proof-submissions',
    questId,
    proofSubmissionId,
    body: input
      ? {
          description: {
            present: isInputFieldPresent(input, 'description'),
            value: input.description ?? null,
          },
          workerMessage: {
            present: isInputFieldPresent(input, 'workerMessage'),
            value: input.workerMessage ?? null,
          },
          fileIds: {
            present: isInputFieldPresent(input, 'fileIds'),
            value: input.fileIds ?? null,
          },
          storedFiles:
            input.fileFingerprints && input.fileFingerprints.length > 0
              ? input.fileFingerprints.map((fingerprint, position) => ({ fingerprint, position }))
              : (input.storedFiles?.map((stored) => ({
                  position: stored.position,
                  contentType: stored.contentType,
                  sizeBytes: stored.sizeBytes,
                  fileName: stored.fileName,
                })) ?? null),
          failedFiles:
            input.fileFingerprints && input.fileFingerprints.length > 0
              ? null
              : (input.failedFiles ?? null),
          retryPosition: input.retryPosition ?? null,
        }
      : {},
  });

const reviewRequestHashFor = (
  principalId: string,
  operation: string,
  questId: string,
  proofSubmissionId: string,
  decision: QuestV2ProofReviewDecision,
  reason: string | null
): Promise<string> =>
  sha256Json({
    authenticatedMemberId: principalId,
    operation,
    path: '/api/v2/quests/:questId/proof-submissions/:proofSubmissionId/review',
    questId,
    proofSubmissionId,
    body: { decision, reason },
  });

const validPosition = (position: number): boolean =>
  Number.isInteger(position) && position >= 0 && position < maxProofFiles;

const validateStoredFiles = (storedFiles: StoredQuestV2ProofFileInput[]): boolean =>
  storedFiles.length <= maxProofFiles &&
  new Set(storedFiles.map((stored) => stored.position)).size === storedFiles.length &&
  storedFiles.every(
    (stored) =>
      validPosition(stored.position) &&
      allowedAttachmentContentTypes.has(stored.contentType) &&
      Number.isInteger(stored.sizeBytes) &&
      stored.sizeBytes > 0 &&
      stored.sizeBytes <= maxAttachmentSizeBytes
  );

const validateFailedFiles = (failedFiles: QuestV2ProofFailedFile[]): boolean =>
  failedFiles.length <= maxProofFiles &&
  new Set(failedFiles.map((failed) => failed.position)).size === failedFiles.length &&
  failedFiles.every(
    (failed) =>
      validPosition(failed.position) &&
      failed.failureCode.trim().length > 0 &&
      failed.failureCode.length <= 64
  );

const validateFileIds = async (
  transaction: QuestTransaction,
  memberId: string,
  fileIds: string[]
): Promise<boolean> => {
  if (fileIds.length > maxProofFiles || new Set(fileIds).size !== fileIds.length) return false;
  if (fileIds.length === 0) return true;
  const rows = await transaction
    .select({ id: file.id, contentType: file.contentType, sizeBytes: file.sizeBytes })
    .from(file)
    .where(
      and(inArray(file.id, fileIds), eq(file.uploadedByUserId, memberId), isNull(file.deletedAt))
    );
  return (
    rows.length === fileIds.length &&
    rows.every(
      (row) =>
        allowedAttachmentContentTypes.has(row.contentType) &&
        Number.isInteger(row.sizeBytes) &&
        row.sizeBytes > 0 &&
        row.sizeBytes <= maxAttachmentSizeBytes
    )
  );
};

const persistStoredFiles = async (
  transaction: QuestTransaction,
  memberId: string,
  storedFiles: StoredQuestV2ProofFileInput[]
): Promise<ReadyProofFile[]> => {
  if (storedFiles.length === 0) return [];
  const values = storedFiles.map((stored) => ({
    id: crypto.randomUUID(),
    position: stored.position,
    bucket: stored.bucket,
    objectKey: stored.objectKey,
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    uploadedByUserId: memberId,
  }));
  await transaction.insert(file).values(values);
  return values.map((value) => ({ fileId: value.id, position: value.position }));
};

const replaceAttachments = async (
  transaction: QuestTransaction,
  submissionId: string,
  readyFiles: ReadyProofFile[],
  failedFiles: QuestV2ProofFailedFile[],
  now: Date
) => {
  await transaction
    .delete(questV2ProofSubmissionFile)
    .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submissionId));
  if (readyFiles.length + failedFiles.length === 0) return;
  await transaction.insert(questV2ProofSubmissionFile).values([
    ...readyFiles.map(({ fileId, position }) => ({
      proofSubmissionId: submissionId,
      fileId,
      position,
      uploadStatus: 'PROOF_FILE_READY' as const,
      failureCode: null,
      attachedAt: now,
    })),
    ...failedFiles.map((failed) => ({
      proofSubmissionId: submissionId,
      fileId: null,
      position: failed.position,
      uploadStatus: 'PROOF_FILE_FAILED' as const,
      failureCode: failed.failureCode,
      attachedAt: now,
    })),
  ]);
};

const prepareFileIds = async (
  transaction: QuestTransaction,
  memberId: string,
  fileIds: string[],
  storedFiles: StoredQuestV2ProofFileInput[],
  failedFiles: QuestV2ProofFailedFile[]
): Promise<
  | {
      fileIds: string[];
      storedFiles: StoredQuestV2ProofFileInput[];
      failedFiles: QuestV2ProofFailedFile[];
    }
  | { outcome: 'invalid-files' }
> => {
  if (
    fileIds.length + storedFiles.length + failedFiles.length > maxProofFiles ||
    new Set(fileIds).size !== fileIds.length ||
    new Set([
      ...storedFiles.map((stored) => stored.position),
      ...failedFiles.map((failed) => failed.position),
    ]).size !==
      storedFiles.length + failedFiles.length ||
    !validateStoredFiles(storedFiles) ||
    !validateFailedFiles(failedFiles) ||
    !(await validateFileIds(transaction, memberId, fileIds))
  )
    return { outcome: 'invalid-files' };
  return { fileIds, storedFiles, failedFiles };
};

const mergeEditAttachments = async (
  transaction: QuestTransaction,
  submissionId: string,
  input: QuestV2ProofDraftInput,
  storedFiles: ReadyProofFile[]
): Promise<
  | { readyFiles: ReadyProofFile[]; failedFiles: QuestV2ProofFailedFile[] }
  | { outcome: 'invalid-files' }
> => {
  const current = await attachmentRowsFor(transaction, submissionId);
  if (isInputFieldPresent(input, 'fileIds')) {
    const readyFiles = (input.fileIds ?? []).map((fileId, position) => ({ fileId, position }));
    const usedPositions = new Set(readyFiles.map(({ position }) => position));
    const nextPosition = () => {
      for (let position = 0; position < maxProofFiles; position += 1) {
        if (!usedPositions.has(position)) {
          usedPositions.add(position);
          return position;
        }
      }
      return maxProofFiles;
    };
    return {
      readyFiles: [
        ...readyFiles,
        ...storedFiles.map(({ fileId }) => ({ fileId, position: nextPosition() })),
      ],
      failedFiles: (input.failedFiles ?? []).map((failed) => ({
        ...failed,
        position: nextPosition(),
      })),
    };
  }
  const failures = current
    .filter(
      (attachment) =>
        attachment.uploadStatus === 'PROOF_FILE_FAILED' && attachment.failureCode !== null
    )
    .map((attachment) => ({
      position: attachment.position,
      failureCode: attachment.failureCode!,
    }));
  const occupiedPositions = new Set(current.map(({ position }) => position));
  const remainingFailures = [...failures];
  const readyFiles = current
    .filter(
      (attachment) => attachment.uploadStatus === 'PROOF_FILE_READY' && attachment.fileId !== null
    )
    .map((attachment) => ({ fileId: attachment.fileId!, position: attachment.position }));
  if (
    input.retryPosition !== undefined &&
    !remainingFailures.some(({ position }) => position === input.retryPosition)
  )
    return { outcome: 'invalid-files' };
  const nextPosition = () => {
    for (let position = 0; position < maxProofFiles; position += 1) {
      if (!occupiedPositions.has(position)) {
        occupiedPositions.add(position);
        return position;
      }
    }
    return maxProofFiles;
  };
  for (const [index, stored] of storedFiles.entries()) {
    const retry =
      input.retryPosition !== undefined && index === 0
        ? remainingFailures.splice(
            remainingFailures.findIndex(({ position }) => position === input.retryPosition),
            1
          )[0]
        : remainingFailures.shift();
    readyFiles.push({ fileId: stored.fileId, position: retry?.position ?? nextPosition() });
  }
  const retriedFailures = (input.failedFiles ?? []).map((failed, index) => {
    const retry =
      input.retryPosition !== undefined && index === 0
        ? remainingFailures.splice(
            remainingFailures.findIndex(({ position }) => position === input.retryPosition),
            1
          )[0]
        : remainingFailures.shift();
    return {
      ...failed,
      position: retry?.position ?? nextPosition(),
    };
  });
  return {
    readyFiles,
    failedFiles: [...remainingFailures, ...retriedFailures],
  };
};

/**
 * The fromSnapshot helpers mark replayed results with `replayed: true`, so the
 * controller can clean up request-scoped uploads a replay must not persist.
 */
const replayedSubmissionFromSnapshot = (value: unknown): QuestV2ProofSubmission | undefined => {
  const submission = submissionFromSnapshot(value);
  return submission ? { ...submission, replayed: true } : undefined;
};

const deletionFromSnapshot = (
  value: unknown
): { deleted: true; proofSubmissionId: string } | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as { deleted?: unknown; proofSubmissionId?: unknown };
  if (snapshot.deleted !== true || typeof snapshot.proofSubmissionId !== 'string') return undefined;
  return { deleted: true, proofSubmissionId: snapshot.proofSubmissionId };
};

const completionSnapshotFor = (result: QuestV2CompletionConfirmation) => ({
  ...result,
  confirmedAt: result.confirmedAt.toISOString(),
  reviewDeadlineAt: result.reviewDeadlineAt.toISOString(),
});

const completionFromSnapshot = (value: unknown): QuestV2CompletionConfirmation | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<QuestV2CompletionConfirmation>;
  const confirmedAt = dateFromSnapshot(snapshot.confirmedAt);
  const reviewDeadlineAt = dateFromSnapshot(snapshot.reviewDeadlineAt);
  if (
    typeof snapshot.id !== 'string' ||
    snapshot.confirmed !== true ||
    !confirmedAt ||
    !reviewDeadlineAt ||
    snapshot.reviewStatus !== 'COMPLETION_CONFIRMATION_PENDING' ||
    typeof snapshot.questStatus !== 'string' ||
    !isQuestV2State(snapshot.questStatus)
  )
    return undefined;
  return {
    id: snapshot.id,
    confirmed: true,
    confirmedAt,
    reviewDeadlineAt,
    reviewStatus: snapshot.reviewStatus,
    questStatus: snapshot.questStatus,
  };
};

const completionConfirmationSnapshotFor = (result: QuestV2CompletionConfirmationReview) => ({
  confirmation: {
    ...result.confirmation,
    confirmedAt: result.confirmation.confirmedAt.toISOString(),
    reviewDeadlineAt: result.confirmation.reviewDeadlineAt?.toISOString() ?? null,
    reviewedAt: result.confirmation.reviewedAt?.toISOString() ?? null,
  },
  questStatus: result.questStatus,
});

const completionConfirmationFromSnapshot = (
  value: unknown
): QuestV2CompletionConfirmationReview | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as {
    confirmation?: Partial<QuestV2CompletionConfirmationRecord> & {
      confirmedAt?: unknown;
      reviewDeadlineAt?: unknown;
      reviewedAt?: unknown;
    };
    questStatus?: unknown;
  };
  const confirmation = snapshot.confirmation;
  if (!confirmation || typeof confirmation.id !== 'string') return undefined;
  const confirmedAt = dateFromSnapshot(confirmation.confirmedAt);
  const reviewDeadlineAt = dateFromSnapshot(confirmation.reviewDeadlineAt);
  const reviewedAt = dateFromSnapshot(confirmation.reviewedAt);
  if (
    !confirmedAt ||
    typeof confirmation.questId !== 'string' ||
    typeof confirmation.confirmedByUserId !== 'string' ||
    !isCompletionConfirmationStatus(confirmation.reviewStatus) ||
    typeof snapshot.questStatus !== 'string' ||
    !isQuestV2State(snapshot.questStatus)
  )
    return undefined;
  return {
    confirmation: {
      id: confirmation.id,
      questId: confirmation.questId,
      workerId: confirmation.workerId ?? null,
      teamId: confirmation.teamId ?? null,
      confirmedByUserId: confirmation.confirmedByUserId,
      confirmedAt,
      reviewStatus: confirmation.reviewStatus,
      reviewDeadlineAt: reviewDeadlineAt ?? null,
      reviewReason: confirmation.reviewReason ?? null,
      reviewedAt: reviewedAt ?? null,
      reviewedBy:
        confirmation.reviewedBy === 'HIRER' || confirmation.reviewedBy === 'AUTO_APPROVE'
          ? confirmation.reviewedBy
          : null,
    },
    questStatus: snapshot.questStatus,
    replayed: true,
  };
};

const reviewSnapshotFor = (result: QuestV2ProofReview) => ({
  proof: snapshotFor(result.proof),
  questStatus: result.questStatus,
});

const writeCommandChecks = async (
  transaction: QuestTransaction,
  current: QuestRow,
  memberId: string,
  questId: string,
  now: Date
): Promise<
  | { owner: ProofOwner }
  | {
      outcome: Extract<
        ProofCommandOutcomeCode,
        | 'due-at-missing'
        | 'due-at-passed'
        | 'hirer-not-allowed'
        | 'not-authorized'
        | 'not-in-progress'
        | 'not-v2-contract'
      >;
    }
> => {
  if (current.hirerId === memberId) return { outcome: 'hirer-not-allowed' as const };
  if (!current.v2Mode || !current.v2Participation) return { outcome: 'not-v2-contract' as const };
  if (current.questState !== 'QUEST_IN_PROGRESS') return { outcome: 'not-in-progress' as const };
  if (!current.dueAt) return { outcome: 'due-at-missing' as const };
  if (current.dueAt.getTime() < now.getTime()) return { outcome: 'due-at-passed' as const };
  const owner = await ownerFor(transaction, current, questId, memberId);
  return owner ? { owner } : { outcome: 'not-authorized' as const };
};

/**
 * Shared Draft-write path behind the two exported entry points: uploads the
 * raw multipart files from the request body outside any transaction, persists
 * through `persist`, and compensates by deleting the uploaded objects when
 * the persist throws or returns a rejected or replayed outcome (recording
 * cleanup tombstones for deletes that fail). A failed file is persisted as a
 * failed position while the first upload error is returned alongside, so the
 * caller still answers the failure status.
 */
const persistUploadedDraft = async (
  memberId: string,
  questId: string,
  body: QuestV2ProofDraftBody,
  persist: (input: QuestV2ProofDraftInput) => Promise<QuestV2ProofSubmissionOutcome>
): Promise<QuestV2ProofSubmissionOutcome | { uploadError: unknown }> => {
  const upload = await uploadFiles(memberId, body.files, body.retryPosition);
  const input = draftInputFor(body, upload);
  if (upload.error) {
    let persisted = false;
    if (upload.uploaded.length + upload.failed.length > 0) {
      try {
        const partial = await persist(input);
        persisted = !('outcome' in partial) && partial.replayed !== true;
      } catch (error) {
        await cleanupUploadedFiles(memberId, questId, upload.uploaded);
        throw error;
      }
    }
    if (!persisted) await cleanupUploadedFiles(memberId, questId, upload.uploaded);
    return { uploadError: upload.error };
  }

  let result: QuestV2ProofSubmissionOutcome;
  try {
    result = await persist(input);
  } catch (error) {
    await cleanupUploadedFiles(memberId, questId, upload.uploaded);
    throw error;
  }
  if ('outcome' in result || result.replayed === true) {
    await cleanupUploadedFiles(memberId, questId, upload.uploaded);
  }
  return result;
};

export const createQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  input: QuestV2ProofDraftInput,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ProofSubmissionOutcome> => {
  const requestHash = await requestHashFor(memberId, 'create', questId, null, input);
  return db.transaction(async (transaction) => {
    // The Quest row is locked before runQuestCommand; see the lock-order note there.
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2ProofCreateOperationScope,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2ProofSubmission, QuestV2ProofBusinessOutcomeCode>
      > => {
        if (!current.proofRequired) return { kind: 'rejected', rejection: 'not-required' };
        const checks = await writeCommandChecks(transaction, current, memberId, questId, now);
        if ('outcome' in checks) return { kind: 'rejected', rejection: checks.outcome };
        const description = normalizedDescription(input.description);
        if ('outcome' in description) return { kind: 'rejected', rejection: description.outcome };
        const workerMessage = normalizedWorkerMessage(input.workerMessage);
        if ('outcome' in workerMessage)
          return { kind: 'rejected', rejection: workerMessage.outcome };
        if (input.retryPosition !== undefined) {
          return { kind: 'rejected', rejection: 'invalid-files' };
        }
        const inputFileIds = input.fileIds ?? [];
        const uploadedFiles = input.storedFiles ?? [];
        const failedFiles = input.failedFiles ?? [];
        if (
          description.value === null &&
          workerMessage.value === null &&
          inputFileIds.length + uploadedFiles.length + failedFiles.length === 0
        ) {
          return { kind: 'rejected', rejection: 'invalid-draft' };
        }
        const existing = await submissionForOwner(transaction, questId, checks.owner);
        if (
          existing &&
          (existing.submissionStatus !== null || existing.submittedByUserId !== memberId)
        ) {
          return { kind: 'rejected', rejection: 'already-exists' };
        }
        const preparedFiles = await prepareFileIds(
          transaction,
          memberId,
          inputFileIds,
          uploadedFiles,
          failedFiles
        );
        if ('outcome' in preparedFiles)
          return { kind: 'rejected', rejection: preparedFiles.outcome };
        // A create replaces the submitter's own unsent Draft, so a client that lost
        // track of a Draft (for example after a rejected file) can always start again.
        if (existing) {
          await transaction
            .delete(questV2ProofSubmission)
            .where(eq(questV2ProofSubmission.id, existing.id));
        }

        const readyStoredFiles = await persistStoredFiles(
          transaction,
          memberId,
          preparedFiles.storedFiles
        );
        const readyFiles = [
          ...preparedFiles.fileIds.map((fileId, position) => ({ fileId, position })),
          ...readyStoredFiles,
        ];
        if (new Set(readyFiles.map(({ position }) => position)).size !== readyFiles.length) {
          return { kind: 'rejected', rejection: 'invalid-files' };
        }
        const [created] = await transaction
          .insert(questV2ProofSubmission)
          .values({
            questId,
            workerId: checks.owner.workerId,
            teamId: checks.owner.teamId,
            submittedByUserId: memberId,
            description: description.value,
            workerMessage: workerMessage.value,
            sentAt: null,
            updatedAt: now,
          })
          .returning(submissionFields);
        if (!created) throw new Error('Quest API v2 Proof Submission insert returned no row');
        await replaceAttachments(
          transaction,
          created.id,
          readyFiles,
          preparedFiles.failedFiles,
          now
        );
        const submission = await toSubmission(transaction, created);
        return {
          kind: 'success',
          result: submission,
          resourceType: 'quest-v2-proof-command',
          resourceId: submission.id,
        };
      },
      toSnapshot: snapshotFor,
      fromSnapshot: replayedSubmissionFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};

export const editQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  input: QuestV2ProofDraftInput,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ProofSubmissionOutcome> => {
  const requestHash = await requestHashFor(memberId, 'edit', questId, proofSubmissionId, input);
  return db.transaction(async (transaction) => {
    // The Quest row is locked before runQuestCommand; see the lock-order note there.
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2ProofEditOperationScope,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2ProofSubmission, QuestV2ProofBusinessOutcomeCode>
      > => {
        if (!current.proofRequired) return { kind: 'rejected', rejection: 'not-required' };
        const checks = await writeCommandChecks(transaction, current, memberId, questId, now);
        if ('outcome' in checks) return { kind: 'rejected', rejection: checks.outcome };
        const submission = await submissionForOwner(transaction, questId, checks.owner);
        if (
          !submission ||
          submission.id !== proofSubmissionId ||
          submission.submittedByUserId !== memberId
        ) {
          return { kind: 'rejected', rejection: 'proof-not-found' };
        }
        if (submission.submissionStatus !== null) {
          return { kind: 'rejected', rejection: 'submission-locked' };
        }

        const description = isInputFieldPresent(input, 'description')
          ? normalizedDescription(input.description)
          : { value: submission.description };
        if ('outcome' in description) return { kind: 'rejected', rejection: description.outcome };
        const workerMessage = isInputFieldPresent(input, 'workerMessage')
          ? normalizedWorkerMessage(input.workerMessage)
          : { value: submission.workerMessage };
        if ('outcome' in workerMessage)
          return { kind: 'rejected', rejection: workerMessage.outcome };
        const uploadedFiles = input.storedFiles ?? [];
        const failedFiles = input.failedFiles ?? [];
        if (input.retryPosition !== undefined && uploadedFiles.length + failedFiles.length !== 1)
          return { kind: 'rejected', rejection: 'invalid-files' };
        const fileIdsToValidate = isInputFieldPresent(input, 'fileIds')
          ? (input.fileIds ?? [])
          : [];
        const preparedFiles = await prepareFileIds(
          transaction,
          memberId,
          fileIdsToValidate,
          uploadedFiles,
          failedFiles
        );
        if ('outcome' in preparedFiles)
          return { kind: 'rejected', rejection: preparedFiles.outcome };
        const readyStoredFiles = await persistStoredFiles(
          transaction,
          memberId,
          preparedFiles.storedFiles
        );
        const mergedFiles = await mergeEditAttachments(
          transaction,
          submission.id,
          input,
          readyStoredFiles
        );
        if ('outcome' in mergedFiles) return { kind: 'rejected', rejection: mergedFiles.outcome };
        if (
          mergedFiles.readyFiles.length + mergedFiles.failedFiles.length > maxProofFiles ||
          new Set(mergedFiles.readyFiles.map(({ position }) => position)).size !==
            mergedFiles.readyFiles.length ||
          new Set([
            ...mergedFiles.readyFiles.map(({ position }) => position),
            ...mergedFiles.failedFiles.map(({ position }) => position),
          ]).size !==
            mergedFiles.readyFiles.length + mergedFiles.failedFiles.length ||
          !(await validateFileIds(
            transaction,
            memberId,
            mergedFiles.readyFiles.map(({ fileId }) => fileId)
          )) ||
          (description.value === null &&
            workerMessage.value === null &&
            mergedFiles.readyFiles.length + mergedFiles.failedFiles.length === 0)
        )
          return {
            kind: 'rejected',
            rejection:
              description.value === null &&
              workerMessage.value === null &&
              mergedFiles.readyFiles.length + mergedFiles.failedFiles.length === 0
                ? 'invalid-draft'
                : 'invalid-files',
          };
        const [updated] = await transaction
          .update(questV2ProofSubmission)
          .set({
            description: description.value,
            workerMessage: workerMessage.value,
            updatedAt: now,
          })
          .where(eq(questV2ProofSubmission.id, submission.id))
          .returning(submissionFields);
        if (!updated) throw new Error('Quest API v2 Proof Submission update returned no row');
        await replaceAttachments(
          transaction,
          updated.id,
          mergedFiles.readyFiles,
          mergedFiles.failedFiles,
          now
        );
        const result = await toSubmission(transaction, updated);
        return {
          kind: 'success',
          result,
          resourceType: 'quest-v2-proof-command',
          resourceId: result.id,
        };
      },
      toSnapshot: snapshotFor,
      fromSnapshot: replayedSubmissionFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};

export const createQuestV2ProofSubmissionWithFiles = async (
  memberId: string,
  questId: string,
  body: QuestV2ProofDraftBody,
  commandId: string
): Promise<QuestV2ProofSubmissionOutcome | { uploadError: unknown }> =>
  persistUploadedDraft(memberId, questId, body, (input) =>
    createQuestV2ProofSubmission(memberId, questId, input, commandId)
  );

export const editQuestV2ProofSubmissionWithFiles = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  body: QuestV2ProofDraftBody,
  commandId: string
): Promise<QuestV2ProofSubmissionOutcome | { uploadError: unknown }> =>
  persistUploadedDraft(memberId, questId, body, (input) =>
    editQuestV2ProofSubmission(memberId, questId, proofSubmissionId, input, commandId)
  );

export const deleteQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ProofSubmissionDeleteOutcome> => {
  const requestHash = await requestHashFor(memberId, 'delete', questId, proofSubmissionId, null);
  return db.transaction(async (transaction) => {
    // The Quest row is locked before runQuestCommand; see the lock-order note there.
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2ProofDeleteOperationScope,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<
          { deleted: true; proofSubmissionId: string },
          QuestV2ProofBusinessOutcomeCode
        >
      > => {
        if (!current.proofRequired) return { kind: 'rejected', rejection: 'not-required' };
        const checks = await writeCommandChecks(transaction, current, memberId, questId, now);
        if ('outcome' in checks) return { kind: 'rejected', rejection: checks.outcome };
        const submission = await submissionForOwner(transaction, questId, checks.owner);
        if (
          !submission ||
          submission.id !== proofSubmissionId ||
          submission.submittedByUserId !== memberId
        ) {
          return { kind: 'rejected', rejection: 'proof-not-found' };
        }
        if (submission.submissionStatus !== null) {
          return { kind: 'rejected', rejection: 'submission-locked' };
        }
        await transaction
          .delete(questV2ProofSubmission)
          .where(eq(questV2ProofSubmission.id, proofSubmissionId));
        return {
          kind: 'success',
          result: { deleted: true, proofSubmissionId },
          resourceId: proofSubmissionId,
        };
      },
      toSnapshot: (result) => result,
      fromSnapshot: deletionFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};

export const submitQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ProofSubmissionOutcome> => {
  const requestHash = await requestHashFor(memberId, 'submit', questId, proofSubmissionId, null);
  return db.transaction(async (transaction) => {
    // The Quest row is locked before runQuestCommand; see the lock-order note there.
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2ProofSubmitOperationScope,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2ProofSubmission, QuestV2ProofBusinessOutcomeCode>
      > => {
        if (!current.proofRequired) return { kind: 'rejected', rejection: 'not-required' };
        const checks = await writeCommandChecks(transaction, current, memberId, questId, now);
        if ('outcome' in checks) return { kind: 'rejected', rejection: checks.outcome };
        const submission = await submissionForOwner(transaction, questId, checks.owner);
        if (
          !submission ||
          submission.id !== proofSubmissionId ||
          submission.submittedByUserId !== memberId
        ) {
          return { kind: 'rejected', rejection: 'proof-not-found' };
        }
        if (submission.submissionStatus !== null)
          return { kind: 'rejected', rejection: 'already-sent' };
        const attachments = await attachmentRowsFor(transaction, submission.id);
        if (attachments.some((attachment) => attachment.uploadStatus === 'PROOF_FILE_FAILED')) {
          return { kind: 'rejected', rejection: 'files-failed' };
        }
        if (attachments.length === 0) return { kind: 'rejected', rejection: 'files-required' };
        const [sent] = await transaction
          .update(questV2ProofSubmission)
          .set({
            submissionStatus: 'PROOF_PENDING',
            sentAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(questV2ProofSubmission.id, submission.id),
              isNull(questV2ProofSubmission.submissionStatus)
            )
          )
          .returning(submissionFields);
        if (!sent) return { kind: 'rejected', rejection: 'already-sent' };
        const result = await toSubmission(transaction, sent);
        await emitQuestUpdate(transaction, questId, 'PROOF_SUBMITTED', [
          current.hirerId,
          ...(await proofParticipantIds(transaction, sent)),
        ]);
        return {
          kind: 'success',
          result,
          resourceType: 'quest-v2-proof-command',
          resourceId: result.id,
        };
      },
      toSnapshot: snapshotFor,
      fromSnapshot: replayedSubmissionFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};

export const listQuestV2ProofSubmissions = async (
  memberId: string,
  questId: string
): Promise<QuestV2ProofSubmissionListOutcome> => {
  const [current] = await db
    .select({ hirerId: quest.hirerId })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!current) return { outcome: 'not-found' };
  if (current.hirerId !== memberId) {
    const [assignment] = await db
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, questId),
          eq(questAssignment.workerId, memberId),
          ne(questAssignment.assignmentStatus, 'ASSIGNMENT_CANCELLED')
        )
      )
      .limit(1);
    if (!assignment) return { outcome: 'not-authorized' };
  }

  const rows = await db
    .select(submissionFields)
    .from(questV2ProofSubmission)
    .where(eq(questV2ProofSubmission.questId, questId))
    .orderBy(asc(questV2ProofSubmission.createdAt), asc(questV2ProofSubmission.id));
  const submissions = await Promise.all(
    rows.map(async (row) => {
      const isAuthor = row.submittedByUserId === memberId;
      if (row.sentAt === null && !isAuthor) return undefined;
      const full = isAuthor || (current.hirerId === memberId && row.sentAt !== null);
      return toSubmission(db, row, full ? 'FULL' : 'SUMMARY', full);
    })
  );
  return submissions.filter(
    (submission): submission is QuestV2ProofSubmission => submission !== undefined
  );
};
export type QuestV2ProofFileAccess = {
  fileId: string;
  contentType: string;
  sizeBytes: number;
  position: number;
  url: string;
  urlExpiresAt: string;
};

export const getQuestV2ProofFile = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  fileId: string
): Promise<QuestV2ProofFileAccess | undefined> => {
  const [row] = await db
    .select({
      hirerId: quest.hirerId,
      submittedByUserId: questV2ProofSubmission.submittedByUserId,
      sentAt: questV2ProofSubmission.sentAt,
      fileId: questV2ProofSubmissionFile.fileId,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      position: questV2ProofSubmissionFile.position,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(questV2ProofSubmissionFile)
    .innerJoin(
      questV2ProofSubmission,
      eq(questV2ProofSubmission.id, questV2ProofSubmissionFile.proofSubmissionId)
    )
    .innerJoin(quest, eq(quest.id, questV2ProofSubmission.questId))
    .innerJoin(file, eq(file.id, questV2ProofSubmissionFile.fileId))
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.apiVersion, questApiVersion.v2),
        eq(questV2ProofSubmission.id, proofSubmissionId),
        eq(questV2ProofSubmissionFile.fileId, fileId),
        eq(questV2ProofSubmissionFile.uploadStatus, 'PROOF_FILE_READY'),
        isNull(file.deletedAt)
      )
    )
    .limit(1);

  if (
    !row ||
    row.fileId === null ||
    (row.hirerId !== memberId && row.submittedByUserId !== memberId) ||
    (row.hirerId === memberId && row.sentAt === null)
  ) {
    return undefined;
  }

  const link = questV2ProofStorage.linkForWithExpiry({
    bucket: row.bucket,
    objectKey: row.objectKey,
  });
  return {
    fileId: row.fileId,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    position: row.position,
    url: link.url,
    urlExpiresAt: link.expiresAt.toISOString(),
  };
};

export const confirmQuestV2Completion = async (
  memberId: string,
  questId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2CompletionConfirmationOutcome> => {
  const requestHash = await requestHashFor(memberId, 'confirm-completion', questId, null, null);
  // The confirmation and its Hirer notification are one transaction. Review and
  // settlement use a separate idempotent command after the Hirer decides.
  return db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (!current) return { outcome: 'not-found' };
    const command = await runQuestCommand({
      transaction,
      identity: {
        principalUserId: memberId,
        operationScope: questV2CompletionConfirmationOperationScope,
        key: rawCommandId,
        requestHash,
        questId,
      },
      now,
      work: async (): Promise<
        QuestCommandWork<QuestV2CompletionConfirmation, QuestV2ProofBusinessOutcomeCode>
      > => {
        if (current.proofRequired) return { kind: 'rejected', rejection: 'not-required' };
        const checks = await writeCommandChecks(transaction, current, memberId, questId, now);
        if ('outcome' in checks) return { kind: 'rejected', rejection: checks.outcome };
        const [existing] = await transaction
          .select({
            id: questV2CompletionConfirmation.id,
          })
          .from(questV2CompletionConfirmation)
          .where(
            and(
              eq(questV2CompletionConfirmation.questId, questId),
              checks.owner.workerId
                ? eq(questV2CompletionConfirmation.workerId, checks.owner.workerId)
                : eq(questV2CompletionConfirmation.teamId, checks.owner.teamId!)
            )
          )
          .limit(1)
          .for('update');
        if (existing) return { kind: 'rejected', rejection: 'already-confirmed' };
        const currentQuestState = current.questState;
        if (!isQuestV2State(currentQuestState))
          return { kind: 'rejected', rejection: 'not-v2-contract' };
        const [confirmation] = await transaction
          .insert(questV2CompletionConfirmation)
          .values({
            questId,
            workerId: checks.owner.workerId,
            teamId: checks.owner.teamId,
            confirmedByUserId: memberId,
            confirmedAt: now,
            reviewStatus: 'COMPLETION_CONFIRMATION_PENDING',
            reviewDeadlineAt: new Date(now.getTime() + completionAutoApprovalWindowMs),
          })
          .returning({
            id: questV2CompletionConfirmation.id,
            confirmedAt: questV2CompletionConfirmation.confirmedAt,
            reviewDeadlineAt: questV2CompletionConfirmation.reviewDeadlineAt,
            reviewStatus: questV2CompletionConfirmation.reviewStatus,
          });
        if (!confirmation)
          throw new Error('Quest API v2 Completion Confirmation insert returned no row');
        const participants = await proofParticipantIds(transaction, checks.owner);
        await emitQuestUpdate(transaction, questId, 'COMPLETION_REVIEW_PENDING', [
          current.hirerId,
          ...participants,
        ]);
        await enqueueCompletionConfirmationPush(transaction, {
          recipientMemberId: current.hirerId,
          questId,
          confirmationId: confirmation.id,
          eventType: 'COMPLETION_REVIEW_PENDING',
          reviewDeadlineAt: confirmation.reviewDeadlineAt!,
          now,
        });
        return {
          kind: 'success',
          result: {
            id: confirmation.id,
            confirmed: true,
            confirmedAt: confirmation.confirmedAt,
            reviewDeadlineAt: confirmation.reviewDeadlineAt!,
            reviewStatus: confirmation.reviewStatus as QuestV2CompletionConfirmationStatus,
            questStatus: currentQuestState,
          },
        };
      },
      toSnapshot: completionSnapshotFor,
      fromSnapshot: completionFromSnapshot,
    });
    if ('outcome' in command) return { outcome: command.outcome };
    if (command.kind === 'success') return command.result;
    return { outcome: command.rejection };
  });
};

type ReviewCommandActor = { actorType: 'MEMBER'; actorUserId: string } | { actorType: 'SYSTEM' };

const completionConfirmationFields = {
  id: questV2CompletionConfirmation.id,
  questId: questV2CompletionConfirmation.questId,
  workerId: questV2CompletionConfirmation.workerId,
  teamId: questV2CompletionConfirmation.teamId,
  confirmedByUserId: questV2CompletionConfirmation.confirmedByUserId,
  confirmedAt: questV2CompletionConfirmation.confirmedAt,
  reviewStatus: questV2CompletionConfirmation.reviewStatus,
  reviewDeadlineAt: questV2CompletionConfirmation.reviewDeadlineAt,
  reviewReason: questV2CompletionConfirmation.reviewReason,
  reviewedAt: questV2CompletionConfirmation.reviewedAt,
  reviewedBy: questV2CompletionConfirmation.reviewedBy,
} as const;

const toCompletionConfirmationRecord = (
  row: QuestV2CompletionConfirmationRecord
): QuestV2CompletionConfirmationRecord => row;

const completionReviewReason = (
  decision: QuestV2CompletionConfirmationReviewDecision,
  reason: string | null
):
  | { reason: string | null }
  | { outcome: 'completion-review-reason-required' | 'completion-review-reason-invalid' } => {
  const value = reason?.trim() ?? null;
  if (decision === 'COMPLETION_CONFIRMATION_APPROVED' && value !== null) {
    return { outcome: 'completion-review-reason-invalid' };
  }
  if (decision === 'COMPLETION_CONFIRMATION_NOT_APPROVED' && value === null) {
    return { outcome: 'completion-review-reason-required' };
  }
  if (value !== null && value.length > maxDescriptionLength) {
    return { outcome: 'completion-review-reason-invalid' };
  }
  return { reason: value };
};

export const listQuestV2CompletionConfirmations = async (
  memberId: string,
  questId: string
): Promise<QuestV2CompletionConfirmationListOutcome> => {
  const [current] = await db
    .select({ hirerId: quest.hirerId, questStatus: quest.questStatus })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1);
  if (!current) return { outcome: 'not-found' };

  if (current.hirerId === memberId) {
    const rows = await db
      .select(completionConfirmationFields)
      .from(questV2CompletionConfirmation)
      .where(eq(questV2CompletionConfirmation.questId, questId))
      .orderBy(
        asc(questV2CompletionConfirmation.confirmedAt),
        asc(questV2CompletionConfirmation.id)
      );
    return rows.sort(
      (left, right) =>
        Number(right.reviewStatus === 'COMPLETION_CONFIRMATION_PENDING') -
          Number(left.reviewStatus === 'COMPLETION_CONFIRMATION_PENDING') ||
        left.confirmedAt.getTime() - right.confirmedAt.getTime()
    );
  }

  const [assignment] = await db
    .select({
      id: questAssignment.id,
      assignmentStatus: questAssignment.assignmentStatus,
    })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.workerId, memberId)))
    .limit(1);
  if (!assignment) return { outcome: 'not-authorized' };
  const cancelledParticipant = assignment.assignmentStatus === 'ASSIGNMENT_CANCELLED';
  if (cancelledParticipant && current.questStatus !== 'QUEST_CANCELLED') {
    return { outcome: 'not-authorized' };
  }

  const [team] = await db
    .select({ id: questCandidateTeamV2Member.teamId })
    .from(questCandidateTeamV2Member)
    .innerJoin(
      questCandidateTeamV2,
      and(
        eq(questCandidateTeamV2.id, questCandidateTeamV2Member.teamId),
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
      )
    )
    .where(eq(questCandidateTeamV2Member.memberId, memberId))
    .limit(1);
  const ownerConditions = [eq(questV2CompletionConfirmation.workerId, memberId)];
  if (team) ownerConditions.push(eq(questV2CompletionConfirmation.teamId, team.id));
  if (cancelledParticipant) {
    const [cancelledConfirmation] = await db
      .select({ id: questV2CompletionConfirmation.id })
      .from(questV2CompletionConfirmation)
      .where(
        and(
          eq(questV2CompletionConfirmation.questId, questId),
          eq(questV2CompletionConfirmation.reviewStatus, 'COMPLETION_CONFIRMATION_CANCELLED'),
          ownerConditions.length === 1 ? ownerConditions[0]! : or(...ownerConditions)
        )
      )
      .limit(1);
    if (!cancelledConfirmation) return { outcome: 'not-authorized' };
  }
  const rows = await db
    .select(completionConfirmationFields)
    .from(questV2CompletionConfirmation)
    .where(
      and(
        eq(questV2CompletionConfirmation.questId, questId),
        ownerConditions.length === 1 ? ownerConditions[0]! : or(...ownerConditions)
      )
    )
    .orderBy(asc(questV2CompletionConfirmation.confirmedAt), asc(questV2CompletionConfirmation.id));
  return rows
    .sort(
      (left, right) =>
        Number(right.reviewStatus === 'COMPLETION_CONFIRMATION_PENDING') -
          Number(left.reviewStatus === 'COMPLETION_CONFIRMATION_PENDING') ||
        left.confirmedAt.getTime() - right.confirmedAt.getTime()
    )
    .map((row) =>
      toCompletionConfirmationRecord(
        row.confirmedByUserId === memberId ? row : { ...row, reviewReason: null }
      )
    );
};

type ReviewCommandInput = {
  principalId: string;
  actor: ReviewCommandActor;
  operationScope: string;
  questId: string;
  proofSubmissionId: string;
  decision: QuestV2ProofReviewDecision;
  reason: string | null;
  commandId: string;
  requestHash: string;
  now: Date;
};

type ReviewSubject = {
  assignmentIds: string[];
  assignmentId: string;
  workerId: string;
  teamId: string | null;
};

const auditActorFor = (actor: ReviewCommandActor): AuditActor =>
  actor.actorType === 'MEMBER'
    ? { actorType: 'MEMBER', actorUserId: actor.actorUserId }
    : { actorType: 'SYSTEM' };

const reviewSubjectFor = async (
  transaction: QuestTransaction,
  questId: string,
  submission: SubmissionRow,
  current: QuestRow
): Promise<ReviewSubject | undefined> => {
  const assignments = await transaction
    .select({ id: questAssignment.id, workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        ne(questAssignment.assignmentStatus, 'ASSIGNMENT_CANCELLED')
      )
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id))
    .for('update');

  const groupCandidate =
    current.v2Mode === questV2Mode.candidate &&
    current.v2Participation === questV2Participation.group;
  if (groupCandidate) {
    if (!submission.teamId) return undefined;
    const [team] = await transaction
      .select({ id: questCandidateTeamV2.id, leaderId: questCandidateTeamV2.leaderId })
      .from(questCandidateTeamV2)
      .where(
        and(
          eq(questCandidateTeamV2.id, submission.teamId),
          eq(questCandidateTeamV2.questId, questId),
          eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
        )
      )
      .limit(1)
      .for('update');
    if (!team) return undefined;
    const [leaderAssignment] = assignments.filter(({ workerId }) => workerId === team.leaderId);
    if (!leaderAssignment) return undefined;
    return {
      assignmentIds: assignments.map(({ id }) => id),
      assignmentId: leaderAssignment.id,
      workerId: team.leaderId,
      teamId: team.id,
    };
  }

  if (!submission.workerId) return undefined;
  const assignment = assignments.find(({ workerId }) => workerId === submission.workerId);
  if (!assignment) return undefined;
  return {
    assignmentIds: [assignment.id],
    assignmentId: assignment.id,
    workerId: submission.workerId,
    teamId: null,
  };
};

const completionReviewSubjectFor = async (
  transaction: QuestTransaction,
  questId: string,
  confirmation: QuestV2CompletionConfirmationRecord
): Promise<ReviewSubject | undefined> => {
  if (confirmation.workerId) {
    const assignments = await transaction
      .select({ id: questAssignment.id, workerId: questAssignment.workerId })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, questId),
          eq(questAssignment.workerId, confirmation.workerId),
          ne(questAssignment.assignmentStatus, 'ASSIGNMENT_CANCELLED')
        )
      )
      .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id))
      .for('update');
    const assignment = assignments[0];
    if (!assignment) return undefined;
    return {
      assignmentIds: assignments.map(({ id }) => id),
      assignmentId: assignment.id,
      workerId: assignment.workerId,
      teamId: null,
    };
  }
  if (!confirmation.teamId) return undefined;
  const [team] = await transaction
    .select({ leaderId: questCandidateTeamV2.leaderId })
    .from(questCandidateTeamV2)
    .where(
      and(
        eq(questCandidateTeamV2.id, confirmation.teamId),
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
      )
    )
    .limit(1)
    .for('update');
  if (!team) return undefined;
  const assignments = await transaction
    .select({ id: questAssignment.id, workerId: questAssignment.workerId })
    .from(questAssignment)
    .innerJoin(
      questCandidateTeamV2Member,
      eq(questCandidateTeamV2Member.memberId, questAssignment.workerId)
    )
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questCandidateTeamV2Member.teamId, confirmation.teamId),
        ne(questAssignment.assignmentStatus, 'ASSIGNMENT_CANCELLED')
      )
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id))
    .for('update');
  const leaderAssignment = assignments.find(({ workerId }) => workerId === team.leaderId);
  if (!leaderAssignment || assignments.length === 0) return undefined;
  return {
    assignmentIds: assignments.map(({ id }) => id),
    assignmentId: leaderAssignment.id,
    workerId: team.leaderId,
    teamId: confirmation.teamId,
  };
};

const normalizedReviewReason = (
  decision: QuestV2ProofReviewDecision,
  reason: string | null
):
  | { reason: string | null }
  | {
      outcome: Extract<
        ProofCommandOutcomeCode,
        'invalid-review-decision' | 'review-reason-invalid' | 'review-reason-required'
      >;
    } => {
  if (decision !== 'PROOF_APPROVED' && decision !== 'PROOF_NOT_APPROVED') {
    return { outcome: 'invalid-review-decision' };
  }
  const value = reason?.trim() ?? null;
  if (value !== null && value.length > maxDescriptionLength) {
    return { outcome: 'review-reason-invalid' };
  }
  if (decision === 'PROOF_APPROVED' && value !== null) {
    return { outcome: 'review-reason-invalid' };
  }
  if (decision === 'PROOF_NOT_APPROVED' && value === null) {
    return { outcome: 'review-reason-required' };
  }
  return { reason: value };
};

const recordProofDecisionAudit = async (
  transaction: QuestTransaction,
  actor: ReviewCommandActor,
  proofSubmissionId: string,
  decision: QuestV2ProofReviewDecision,
  reason: string | null,
  now: Date
) =>
  recordAudit(transaction, {
    ...auditActorFor(actor),
    action: 'PROOF_REVIEWED',
    resourceType: 'PROOF_SUBMISSION',
    resourceId: proofSubmissionId,
    oldValue: { status: 'PROOF_PENDING' },
    newValue: { status: decision },
    reason,
    createdAt: now,
  });

const recordAssignmentAudits = async (
  transaction: QuestTransaction,
  actor: ReviewCommandActor,
  assignmentIds: string[],
  status: 'ASSIGNMENT_COMPLETED' | 'ASSIGNMENT_INCOMPLETE',
  now: Date
) => {
  for (const assignmentId of assignmentIds) {
    await recordAudit(transaction, {
      ...auditActorFor(actor),
      action: 'ASSIGNMENT_STATE_CHANGED',
      resourceType: 'ASSIGNMENT',
      resourceId: assignmentId,
      oldValue: { state: 'ASSIGNMENT_ACTIVE' },
      newValue: { state: status },
      createdAt: now,
    });
  }
};

type CompletionReviewCommandInput = {
  principalId: string;
  actor: ReviewCommandActor;
  operationScope: string;
  questId: string;
  completionConfirmationId: string;
  decision: QuestV2CompletionConfirmationReviewDecision;
  reason: string | null;
  commandId: string;
  requestHash: string;
  now: Date;
};

const createCompletionConfirmationAdminReviewItem = async (
  transaction: QuestTransaction,
  input: {
    actor: ReviewCommandActor;
    questId: string;
    confirmation: QuestV2CompletionConfirmationRecord;
    subject: ReviewSubject;
    hirerId: string;
    reason: string;
    now: Date;
  }
) => {
  const [reviewItem] = await transaction
    .insert(adminReviewItem)
    .values({
      questId: input.questId,
      assignmentId: input.subject.assignmentId,
      proofSubmissionId: null,
      completionConfirmationId: input.confirmation.id,
      hirerId: input.hirerId,
      workerId: input.subject.workerId,
      teamId: input.subject.teamId,
      reason: input.reason,
      evidenceReferences: [],
      createdAt: input.now,
    })
    .returning({ id: adminReviewItem.id });
  if (!reviewItem) throw new Error('Admin Review Item could not be created');
  await recordAudit(transaction, {
    ...auditActorFor(input.actor),
    action: 'ADMIN_REVIEW_ITEM_CREATED',
    resourceType: 'ADMIN_REVIEW_ITEM',
    resourceId: reviewItem.id,
    newValue: {
      questId: input.questId,
      assignmentId: input.subject.assignmentId,
      completionConfirmationId: input.confirmation.id,
      workerId: input.subject.workerId,
      teamId: input.subject.teamId,
      evidenceReferences: [],
    },
    reason: input.reason,
    createdAt: input.now,
  });
};

const reviewQuestV2CompletionConfirmationInTransaction = async (
  transaction: QuestTransaction,
  input: CompletionReviewCommandInput
): Promise<QuestV2CompletionConfirmationReviewOutcome> => {
  const current = await lockQuest(transaction, input.questId);
  if (!current) return { outcome: 'not-found' };
  const command = await runQuestCommand({
    transaction,
    identity: {
      principalUserId: input.principalId,
      operationScope: input.operationScope,
      key: input.commandId,
      requestHash: input.requestHash,
      questId: input.questId,
    },
    now: input.now,
    work: async ({
      commandId,
    }): Promise<
      QuestCommandWork<QuestV2CompletionConfirmationReview, QuestV2ProofBusinessOutcomeCode>
    > => {
      if (input.actor.actorType === 'MEMBER' && current.hirerId !== input.actor.actorUserId) {
        return { kind: 'rejected', rejection: 'hirer-not-allowed' };
      }
      if (current.proofRequired) return { kind: 'rejected', rejection: 'not-required' };
      if (!current.v2Mode || !current.v2Participation) {
        return { kind: 'rejected', rejection: 'not-v2-contract' };
      }
      const [row] = await transaction
        .select(completionConfirmationFields)
        .from(questV2CompletionConfirmation)
        .where(
          and(
            eq(questV2CompletionConfirmation.id, input.completionConfirmationId),
            eq(questV2CompletionConfirmation.questId, input.questId)
          )
        )
        .limit(1)
        .for('update');
      if (!row) {
        return { kind: 'rejected', rejection: 'completion-confirmation-not-found' };
      }
      if (row.reviewStatus !== 'COMPLETION_CONFIRMATION_PENDING') {
        return {
          kind: 'rejected',
          rejection: 'completion-confirmation-review-not-pending',
        };
      }
      const groupFcfs =
        current.v2Mode === questV2Mode.firstComeFirstServed &&
        current.v2Participation === questV2Participation.group;
      if (
        current.questState !== 'QUEST_IN_PROGRESS' &&
        !(groupFcfs && current.questState === 'QUEST_FAILED')
      ) {
        return { kind: 'rejected', rejection: 'not-reviewable' };
      }
      if (!current.dueAt || row.confirmedAt.getTime() > current.dueAt.getTime()) {
        return { kind: 'rejected', rejection: 'due-at-passed' };
      }
      const normalizedReason = completionReviewReason(input.decision, input.reason);
      if ('outcome' in normalizedReason) {
        return { kind: 'rejected', rejection: normalizedReason.outcome };
      }
      const pendingRecord = toCompletionConfirmationRecord(row);
      const subject = await completionReviewSubjectFor(transaction, input.questId, pendingRecord);
      if (!subject) {
        return { kind: 'rejected', rejection: 'completion-confirmation-not-found' };
      }
      const allWorkerIds = await allQuestWorkerIds(transaction, input.questId);
      const activeWorkerIds = await activeAssignmentWorkerIds(transaction, input.questId);
      const [updated] = await transaction
        .update(questV2CompletionConfirmation)
        .set({
          reviewStatus: input.decision,
          reviewReason: normalizedReason.reason,
          reviewedAt: input.now,
          reviewedBy: input.actor.actorType === 'MEMBER' ? 'HIRER' : 'AUTO_APPROVE',
        })
        .where(
          and(
            eq(questV2CompletionConfirmation.id, input.completionConfirmationId),
            eq(questV2CompletionConfirmation.reviewStatus, 'COMPLETION_CONFIRMATION_PENDING')
          )
        )
        .returning(completionConfirmationFields);
      if (!updated) {
        return {
          kind: 'rejected',
          rejection: 'completion-confirmation-review-not-pending',
        };
      }
      const confirmation = toCompletionConfirmationRecord(updated);
      await recordAudit(transaction, {
        ...auditActorFor(input.actor),
        action: 'COMPLETION_CONFIRMATION_REVIEWED',
        resourceType: 'COMPLETION_CONFIRMATION',
        resourceId: confirmation.id,
        oldValue: { status: 'COMPLETION_CONFIRMATION_PENDING' },
        newValue: { status: input.decision },
        reason: normalizedReason.reason,
        createdAt: input.now,
      });

      let questStatus = current.questState as QuestV2State;
      let allocationPending = false;
      let holdsRemainder = false;
      let changedAssignmentIds: string[] = [];
      if (input.decision === 'COMPLETION_CONFIRMATION_APPROVED') {
        const settlement = await settleProofFreeQuestV2InTransaction(
          transaction,
          input.questId,
          commandId,
          input.now,
          groupFcfs ? confirmation.workerId! : undefined,
          input.actor.actorType === 'MEMBER' ? input.actor.actorUserId : null
        );
        questStatus = settlement.questStatus as QuestV2State;
        allocationPending = settlement.allocationPending === true;
        holdsRemainder = settlement.holdsRemainder === true;
        changedAssignmentIds = groupFcfs ? [subject.assignmentId] : subject.assignmentIds;
        await recordAssignmentAudits(
          transaction,
          input.actor,
          changedAssignmentIds,
          'ASSIGNMENT_COMPLETED',
          input.now
        );
        await recordAudit(transaction, {
          ...auditActorFor(input.actor),
          action: allocationPending
            ? 'QUEST_TEAM_REWARD_ALLOCATION_PENDING'
            : 'QUEST_REWARD_SETTLED',
          resourceType: 'QUEST_REWARD',
          resourceId: input.questId,
          newValue: {
            state: allocationPending
              ? 'QUEST_TEAM_REWARD_ALLOCATION_PENDING'
              : 'QUEST_REWARD_SETTLED',
            assignmentIds: changedAssignmentIds,
            paidSatang: settlement.paidSatang,
          },
          createdAt: input.now,
        });
      } else {
        const actorId = input.actor.actorType === 'MEMBER' ? input.actor.actorUserId : null;
        const failure =
          groupFcfs && current.questState === 'QUEST_IN_PROGRESS'
            ? await markAssignmentIncompleteV2InTransaction(
                transaction,
                input.questId,
                subject.assignmentId,
                commandId,
                input.now,
                actorId
              )
            : await failQuestV2InTransaction(
                transaction,
                input.questId,
                subject.assignmentIds,
                commandId,
                input.now,
                actorId
              );
        questStatus = failure.questStatus;
        holdsRemainder = failure.questStatus === 'QUEST_COMPLETED';
        changedAssignmentIds = failure.incompleteAssignmentIds;
        await recordAssignmentAudits(
          transaction,
          input.actor,
          changedAssignmentIds,
          'ASSIGNMENT_INCOMPLETE',
          input.now
        );
        await createCompletionConfirmationAdminReviewItem(transaction, {
          actor: input.actor,
          questId: input.questId,
          confirmation,
          subject,
          hirerId: current.hirerId,
          reason: normalizedReason.reason!,
          now: input.now,
        });
      }

      const participants = await proofParticipantIds(transaction, confirmation);
      const closeReviewedParticipants =
        groupFcfs &&
        input.decision === 'COMPLETION_CONFIRMATION_NOT_APPROVED' &&
        questStatus !== 'QUEST_COMPLETED'
          ? participants
          : [];
      await emitQuestUpdate(
        transaction,
        input.questId,
        'COMPLETION_REVIEWED',
        [current.hirerId, ...participants],
        closeReviewedParticipants
      );
      await enqueueCompletionConfirmationPush(transaction, {
        recipientMemberId: confirmation.confirmedByUserId,
        questId: input.questId,
        confirmationId: confirmation.id,
        eventType: 'COMPLETION_REVIEWED',
        decision: input.decision,
        reviewedBy: confirmation.reviewedBy!,
        now: input.now,
      });

      if (questStatus === 'QUEST_FAILED' && current.questState !== 'QUEST_FAILED') {
        await emitQuestUpdate(
          transaction,
          input.questId,
          'QUEST_FAILED',
          [current.hirerId, ...allWorkerIds],
          allWorkerIds
        );
        await emitQuestUpdate(transaction, input.questId, 'DISPUTE_WINDOW_OPENED', [
          current.hirerId,
          ...allWorkerIds,
        ]);
        await enqueueQuestFailedPush(transaction, {
          recipientMemberIds: allWorkerIds,
          questId: input.questId,
          reason: 'COMPLETION_NOT_APPROVED',
          now: input.now,
        });
      } else if (questStatus === 'QUEST_COMPLETED' && holdsRemainder) {
        // Not-approved Workers keep their Quest socket while the money hold is open.
        const incomplete = await assignmentsWithStatus(transaction, input.questId, [
          'ASSIGNMENT_INCOMPLETE',
        ]);
        const incompleteWorkerIds = incomplete.map(({ workerId }) => workerId);
        const recipientIds = [current.hirerId, ...activeWorkerIds, ...incompleteWorkerIds];
        await emitQuestUpdate(transaction, input.questId, 'QUEST_COMPLETED', recipientIds);
        await emitQuestUpdate(
          transaction,
          input.questId,
          'DISPUTE_WINDOW_OPENED',
          recipientIds,
          activeWorkerIds.filter((workerId) => !incompleteWorkerIds.includes(workerId))
        );
        await enqueueQuestCompletedDisputeWindowPush(transaction, {
          recipients: incomplete,
          questId: input.questId,
          now: input.now,
        });
      } else if (questStatus === 'QUEST_COMPLETED') {
        await emitQuestUpdate(
          transaction,
          input.questId,
          'QUEST_COMPLETED',
          [current.hirerId, ...allWorkerIds],
          allocationPending ? [] : allWorkerIds
        );
      }

      const relatedMemberIds = changedAssignmentIds.length
        ? (
            await transaction
              .select({ workerId: questAssignment.workerId })
              .from(questAssignment)
              .where(inArray(questAssignment.id, [...new Set(changedAssignmentIds)]))
          ).map(({ workerId }) => workerId)
        : [];
      return {
        kind: 'success',
        result: { confirmation, questStatus },
        resourceType: 'quest-v2-completion-confirmation',
        resourceId: confirmation.id,
        relatedMemberIds: [...new Set(relatedMemberIds)],
      };
    },
    toSnapshot: completionConfirmationSnapshotFor,
    fromSnapshot: completionConfirmationFromSnapshot,
  });
  if ('outcome' in command) return { outcome: command.outcome };
  if (command.kind === 'success') return command.result;
  return { outcome: command.rejection };
};

export const reviewQuestV2CompletionConfirmation = async (
  memberId: string,
  questId: string,
  completionConfirmationId: string,
  decision: QuestV2CompletionConfirmationReviewDecision,
  reason: string | null,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2CompletionConfirmationReviewOutcome> => {
  const normalizedReason = reason?.trim() ?? null;
  const requestHash = await sha256Json({
    authenticatedMemberId: memberId,
    operation: 'completion-review',
    questId,
    completionConfirmationId,
    decision,
    reason: normalizedReason,
  });
  return db.transaction((transaction) =>
    reviewQuestV2CompletionConfirmationInTransaction(transaction, {
      principalId: memberId,
      actor: { actorType: 'MEMBER', actorUserId: memberId },
      operationScope: questV2CompletionConfirmationReviewOperationScope,
      questId,
      completionConfirmationId,
      decision,
      reason,
      commandId: rawCommandId,
      requestHash,
      now,
    })
  );
};

const reviewQuestV2ProofSubmissionInTransaction = async (
  transaction: QuestTransaction,
  input: ReviewCommandInput
): Promise<QuestV2ProofReviewOutcome> => {
  // The Quest row is locked before runQuestCommand; see the lock-order note there.
  const current = await lockQuest(transaction, input.questId);
  if (!current) return { outcome: 'not-found' };
  const command = await runQuestCommand({
    transaction,
    identity: {
      principalUserId: input.principalId,
      operationScope: input.operationScope,
      key: input.commandId,
      requestHash: input.requestHash,
      questId: input.questId,
    },
    now: input.now,
    work: async ({
      commandId,
    }): Promise<QuestCommandWork<QuestV2ProofReview, QuestV2ProofBusinessOutcomeCode>> => {
      if (input.actor.actorType === 'MEMBER' && current.hirerId !== input.actor.actorUserId)
        return { kind: 'rejected', rejection: 'hirer-not-allowed' };
      if (!current.v2Mode || !current.v2Participation) {
        return { kind: 'rejected', rejection: 'not-v2-contract' };
      }
      if (!current.proofRequired) return { kind: 'rejected', rejection: 'not-required' };

      const [submission] = await transaction
        .select(submissionFields)
        .from(questV2ProofSubmission)
        .where(
          and(
            eq(questV2ProofSubmission.id, input.proofSubmissionId),
            eq(questV2ProofSubmission.questId, input.questId)
          )
        )
        .limit(1)
        .for('update');
      if (!submission) return { kind: 'rejected', rejection: 'proof-not-found' };
      if (submission.sentAt === null || submission.submissionStatus === null) {
        return { kind: 'rejected', rejection: 'proof-not-sent' };
      }
      if (submission.submissionStatus !== 'PROOF_PENDING') {
        return { kind: 'rejected', rejection: 'review-not-pending' };
      }
      if (!['QUEST_IN_PROGRESS', 'QUEST_FAILED'].includes(current.questState)) {
        return { kind: 'rejected', rejection: 'not-reviewable' };
      }
      if (!current.dueAt) return { kind: 'rejected', rejection: 'due-at-missing' };
      if (submission.sentAt.getTime() > current.dueAt.getTime()) {
        return { kind: 'rejected', rejection: 'due-at-passed' };
      }

      const subject = await reviewSubjectFor(transaction, input.questId, submission, current);
      if (!subject) return { kind: 'rejected', rejection: 'proof-not-found' };
      const normalizedReason = normalizedReviewReason(input.decision, input.reason);
      if ('outcome' in normalizedReason) {
        return { kind: 'rejected', rejection: normalizedReason.outcome };
      }

      const [updated] = await transaction
        .update(questV2ProofSubmission)
        .set({
          submissionStatus: input.decision,
          reviewReason: normalizedReason.reason,
          reviewedAt: input.now,
          reviewedBy: input.actor.actorType === 'MEMBER' ? 'HIRER' : 'AUTO_APPROVE',
          updatedAt: input.now,
        })
        .where(
          and(
            eq(questV2ProofSubmission.id, input.proofSubmissionId),
            eq(questV2ProofSubmission.submissionStatus, 'PROOF_PENDING')
          )
        )
        .returning(submissionFields);
      if (!updated) return { kind: 'rejected', rejection: 'review-not-pending' };

      const proof = await toSubmission(transaction, updated);
      await recordProofDecisionAudit(
        transaction,
        input.actor,
        proof.id,
        input.decision,
        normalizedReason.reason,
        input.now
      );

      const activeWorkerIds = await activeAssignmentWorkerIds(transaction, input.questId);
      let questStatus: QuestV2State = current.questState as QuestV2State;
      let allocationPending = false;
      let holdsRemainder = false;
      let changedAssignmentIds: string[] = [];
      if (input.decision === 'PROOF_APPROVED') {
        const settlement = await settleApprovedQuestV2ProofInTransaction(
          transaction,
          input.questId,
          proof.id,
          commandId,
          input.now,
          input.actor.actorType === 'MEMBER' ? input.actor.actorUserId : null
        );
        questStatus = settlement.questStatus as QuestV2State;
        allocationPending = settlement.allocationPending;
        holdsRemainder = settlement.holdsRemainder;
        changedAssignmentIds = settlement.completedAssignmentIds;
        await recordAssignmentAudits(
          transaction,
          input.actor,
          settlement.completedAssignmentIds,
          'ASSIGNMENT_COMPLETED',
          input.now
        );
        await recordAudit(transaction, {
          ...auditActorFor(input.actor),
          action: settlement.allocationPending
            ? 'QUEST_TEAM_REWARD_ALLOCATION_PENDING'
            : 'QUEST_REWARD_SETTLED',
          resourceType: 'QUEST_REWARD',
          resourceId: input.questId,
          oldValue: { state: 'QUEST_REWARD_HELD' },
          newValue: {
            state: settlement.allocationPending
              ? 'QUEST_TEAM_REWARD_ALLOCATION_PENDING'
              : 'QUEST_REWARD_SETTLED',
            paidSatang: settlement.paidSatang,
            assignmentIds: settlement.completedAssignmentIds,
          },
          createdAt: input.now,
        });
      } else {
        const actorId = input.actor.actorType === 'MEMBER' ? input.actor.actorUserId : null;
        const reviewsEachWorker =
          current.questState === 'QUEST_IN_PROGRESS' &&
          current.v2Mode === questV2Mode.firstComeFirstServed &&
          current.v2Participation === questV2Participation.group;
        const failure = reviewsEachWorker
          ? await markAssignmentIncompleteV2InTransaction(
              transaction,
              input.questId,
              subject.assignmentId,
              commandId,
              input.now,
              actorId
            )
          : await failQuestV2InTransaction(
              transaction,
              input.questId,
              subject.assignmentIds,
              commandId,
              input.now,
              actorId
            );
        questStatus = failure.questStatus;
        holdsRemainder = failure.questStatus === 'QUEST_COMPLETED';
        changedAssignmentIds = failure.incompleteAssignmentIds;
        const attachments = await attachmentRowsFor(transaction, proof.id);
        const evidenceReferences = attachments
          .filter(
            ({ uploadStatus, fileId }) => uploadStatus === 'PROOF_FILE_READY' && fileId !== null
          )
          .map(({ fileId }) => fileId!);
        const [reviewItem] = await transaction
          .insert(adminReviewItem)
          .values({
            questId: input.questId,
            assignmentId: subject.assignmentId,
            proofSubmissionId: proof.id,
            hirerId: current.hirerId,
            workerId: subject.workerId,
            teamId: subject.teamId,
            reason: normalizedReason.reason!,
            evidenceReferences,
            createdAt: input.now,
          })
          .returning({ id: adminReviewItem.id });
        if (!reviewItem) throw new Error('Admin Review Item could not be created');
        await recordAudit(transaction, {
          ...auditActorFor(input.actor),
          action: 'ADMIN_REVIEW_ITEM_CREATED',
          resourceType: 'ADMIN_REVIEW_ITEM',
          resourceId: reviewItem.id,
          newValue: {
            questId: input.questId,
            assignmentId: subject.assignmentId,
            proofSubmissionId: proof.id,
            workerId: subject.workerId,
            teamId: subject.teamId,
            evidenceReferences,
          },
          reason: normalizedReason.reason,
          createdAt: input.now,
        });
        await recordAssignmentAudits(
          transaction,
          input.actor,
          failure.incompleteAssignmentIds,
          'ASSIGNMENT_INCOMPLETE',
          input.now
        );
      }
      const proofMembers = await proofParticipantIds(transaction, updated);
      const changeType =
        input.operationScope === questV2ProofAutoApprovalOperationScope
          ? 'PROOF_AUTO_APPROVED'
          : 'PROOF_REVIEWED';
      const terminalFailure =
        current.questState === 'QUEST_IN_PROGRESS' && questStatus === 'QUEST_FAILED';
      const pendingAfterFailure =
        questStatus === 'QUEST_FAILED' && current.dueAt
          ? await failedQuestPendingProofParticipantIds(transaction, input.questId, current.dueAt)
          : [];
      const closesAffected =
        !terminalFailure && questStatus !== 'QUEST_COMPLETED' ? proofMembers : [];
      await emitQuestUpdate(
        transaction,
        input.questId,
        changeType,
        [current.hirerId, ...proofMembers],
        closesAffected
      );
      if (terminalFailure) {
        const failureRecipientIds = await failureRecipientWorkerIds(transaction, input.questId);
        const closeMemberIds = activeWorkerIds.filter(
          (workerId) => !pendingAfterFailure.includes(workerId)
        );
        await emitQuestUpdate(
          transaction,
          input.questId,
          'QUEST_FAILED',
          [current.hirerId, ...failureRecipientIds],
          closeMemberIds
        );
        await emitQuestUpdate(transaction, input.questId, 'DISPUTE_WINDOW_OPENED', [
          current.hirerId,
          ...failureRecipientIds,
        ]);
        await enqueueQuestFailedPush(transaction, {
          recipientMemberIds: failureRecipientIds,
          questId: input.questId,
          reason: 'PROOF_NOT_APPROVED',
          now: input.now,
        });
      } else if (current.questState !== 'QUEST_COMPLETED' && questStatus === 'QUEST_COMPLETED') {
        if (holdsRemainder) {
          const incomplete = await assignmentsWithStatus(transaction, input.questId, [
            'ASSIGNMENT_INCOMPLETE',
          ]);
          const incompleteWorkerIds = incomplete.map(({ workerId }) => workerId);
          const completedWorkerIds = activeWorkerIds.filter(
            (workerId) => !incompleteWorkerIds.includes(workerId)
          );
          const recipientIds = [current.hirerId, ...activeWorkerIds, ...incompleteWorkerIds];
          await emitQuestUpdate(transaction, input.questId, 'QUEST_COMPLETED', recipientIds);
          await emitQuestUpdate(
            transaction,
            input.questId,
            'DISPUTE_WINDOW_OPENED',
            recipientIds,
            completedWorkerIds
          );
          await enqueueQuestCompletedDisputeWindowPush(transaction, {
            recipients: incomplete,
            questId: input.questId,
            now: input.now,
          });
        } else {
          await emitQuestUpdate(
            transaction,
            input.questId,
            'QUEST_COMPLETED',
            [current.hirerId, ...activeWorkerIds],
            allocationPending ? [] : activeWorkerIds
          );
        }
      }
      if (questStatus === 'QUEST_IN_PROGRESS' && input.decision === 'PROOF_NOT_APPROVED') {
        await enqueueProofNotApprovedPush(transaction, {
          recipientMemberId: subject.workerId,
          assignmentId: subject.assignmentId,
          questId: input.questId,
          now: input.now,
        });
      }
      let relatedMemberIds: string[] = [];
      if (changedAssignmentIds.length > 0) {
        const assignments = await transaction
          .select({ workerId: questAssignment.workerId })
          .from(questAssignment)
          .where(inArray(questAssignment.id, [...new Set(changedAssignmentIds)]));
        relatedMemberIds = [...new Set(assignments.map(({ workerId }) => workerId))];
      }

      return {
        kind: 'success',
        result: { proof, questStatus },
        resourceType: 'quest-v2-proof-command',
        resourceId: proof.id,
        relatedMemberIds,
      };
    },
    toSnapshot: reviewSnapshotFor,
    fromSnapshot: reviewFromSnapshot,
  });
  if ('outcome' in command) return { outcome: command.outcome };
  if (command.kind === 'success') return command.result;
  return { outcome: command.rejection };
};

const reviewQuestV2ProofSubmissionCommand = async (
  input: ReviewCommandInput
): Promise<QuestV2ProofReviewOutcome> =>
  db.transaction((transaction) => reviewQuestV2ProofSubmissionInTransaction(transaction, input));

export const reviewQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  decision: QuestV2ProofReviewDecision,
  reason: string | null,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2ProofReviewOutcome> => {
  const normalizedReason = reason?.trim() ?? null;
  const requestHash = await reviewRequestHashFor(
    memberId,
    'review',
    questId,
    proofSubmissionId,
    decision,
    normalizedReason
  );
  return reviewQuestV2ProofSubmissionCommand({
    principalId: memberId,
    actor: { actorType: 'MEMBER', actorUserId: memberId },
    operationScope: questV2ProofReviewOperationScope,
    questId,
    proofSubmissionId,
    decision,
    reason,
    commandId: rawCommandId,
    requestHash,
    now,
  });
};

const dueQuestV2ProofFailureAssignmentIds = async (
  transaction: QuestTransaction,
  current: QuestRow,
  questId: string
): Promise<string[]> => {
  const assignments = await transaction
    .select({
      id: questAssignment.id,
      workerId: questAssignment.workerId,
      startedAt: questAssignment.startedAt,
    })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    )
    .orderBy(asc(questAssignment.createdAt), asc(questAssignment.id))
    .for('update');
  if (assignments.length === 0 || !current.dueAt) return [];
  if (current.questState === 'QUEST_ASSIGNED') {
    if (
      current.v2Mode === questV2Mode.candidate &&
      current.v2Participation === questV2Participation.group
    ) {
      const [team] = await transaction
        .select({ leaderId: questCandidateTeamV2.leaderId })
        .from(questCandidateTeamV2)
        .where(
          and(
            eq(questCandidateTeamV2.questId, questId),
            eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
          )
        )
        .limit(1)
        .for('update');
      const leaderAssignment = assignments.find(({ workerId }) => workerId === team?.leaderId);
      return leaderAssignment?.startedAt ? [] : assignments.map(({ id }) => id);
    }
    return assignments.filter(({ startedAt }) => !startedAt).map(({ id }) => id);
  }

  const groupCandidate =
    current.v2Mode === questV2Mode.candidate &&
    current.v2Participation === questV2Participation.group;
  const selectedTeam = groupCandidate
    ? (
        await transaction
          .select({ id: questCandidateTeamV2.id })
          .from(questCandidateTeamV2)
          .where(
            and(
              eq(questCandidateTeamV2.questId, questId),
              eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
            )
          )
          .limit(1)
          .for('update')
      )[0]
    : undefined;

  if (groupCandidate) {
    if (!selectedTeam) return assignments.map(({ id }) => id);
    if (current.proofRequired) {
      const [proof] = await transaction
        .select({ id: questV2ProofSubmission.id })
        .from(questV2ProofSubmission)
        .where(
          and(
            eq(questV2ProofSubmission.questId, questId),
            eq(questV2ProofSubmission.teamId, selectedTeam.id),
            isNotNull(questV2ProofSubmission.sentAt),
            lte(questV2ProofSubmission.sentAt, current.dueAt)
          )
        )
        .limit(1);
      return proof ? [] : assignments.map(({ id }) => id);
    }
    const [confirmation] = await transaction
      .select({ id: questV2CompletionConfirmation.id })
      .from(questV2CompletionConfirmation)
      .where(
        and(
          eq(questV2CompletionConfirmation.questId, questId),
          eq(questV2CompletionConfirmation.teamId, selectedTeam.id)
        )
      )
      .limit(1);
    return confirmation ? [] : assignments.map(({ id }) => id);
  }

  const missing: string[] = [];
  for (const assignment of assignments) {
    if (current.proofRequired) {
      const [proof] = await transaction
        .select({ id: questV2ProofSubmission.id })
        .from(questV2ProofSubmission)
        .where(
          and(
            eq(questV2ProofSubmission.questId, questId),
            eq(questV2ProofSubmission.workerId, assignment.workerId),
            isNotNull(questV2ProofSubmission.sentAt),
            lte(questV2ProofSubmission.sentAt, current.dueAt)
          )
        )
        .limit(1);
      if (!proof) missing.push(assignment.id);
    } else {
      const [confirmation] = await transaction
        .select({ id: questV2CompletionConfirmation.id })
        .from(questV2CompletionConfirmation)
        .where(
          and(
            eq(questV2CompletionConfirmation.questId, questId),
            eq(questV2CompletionConfirmation.workerId, assignment.workerId)
          )
        )
        .limit(1);
      if (!confirmation) missing.push(assignment.id);
    }
  }
  return missing;
};

export const failQuestV2AtDueAt = async (questId: string, now = new Date()): Promise<boolean> =>
  db.transaction(async (transaction) => {
    const current = await lockQuest(transaction, questId);
    if (
      !current ||
      !['QUEST_ASSIGNED', 'QUEST_IN_PROGRESS'].includes(current.questState) ||
      !current.dueAt ||
      current.dueAt > now
    ) {
      return false;
    }
    const assignmentIds = await dueQuestV2ProofFailureAssignmentIds(transaction, current, questId);
    if (assignmentIds.length === 0) return false;
    const workerIds = await failureRecipientWorkerIds(transaction, questId);
    const [pendingProofWorkerIds, pendingConfirmationWorkerIds] = await Promise.all([
      failedQuestPendingProofParticipantIds(transaction, questId, current.dueAt),
      pendingCompletionConfirmationParticipantIds(transaction, questId, current.dueAt),
    ]);
    const pendingDecisionWorkerIds = new Set([
      ...pendingProofWorkerIds,
      ...pendingConfirmationWorkerIds,
    ]);
    const failure = await failQuestV2InTransaction(
      transaction,
      questId,
      assignmentIds,
      `quest-v2-due-at-failure:${questId}`,
      now,
      null
    );
    await recordAssignmentAudits(
      transaction,
      { actorType: 'SYSTEM' },
      failure.incompleteAssignmentIds,
      'ASSIGNMENT_INCOMPLETE',
      now
    );
    await emitQuestUpdate(
      transaction,
      questId,
      'QUEST_FAILED',
      [current.hirerId, ...workerIds],
      workerIds.filter((workerId) => !pendingDecisionWorkerIds.has(workerId))
    );
    await emitQuestUpdate(transaction, questId, 'DISPUTE_WINDOW_OPENED', [
      current.hirerId,
      ...workerIds,
    ]);
    await enqueueQuestFailedPush(transaction, {
      recipientMemberIds: workerIds,
      questId,
      reason: 'DUE_AT_MISSED',
      now,
    });
    return true;
  });

export const failDueAtQuestV2Proofs = async (now = new Date(), limit = 100): Promise<string[]> => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const due = await db
    .select({ id: quest.id })
    .from(quest)
    .where(
      and(
        eq(quest.apiVersion, questApiVersion.v2),
        inArray(quest.questStatus, ['QUEST_ASSIGNED', 'QUEST_IN_PROGRESS']),
        lte(quest.dueAt, now)
      )
    )
    .orderBy(asc(quest.dueAt), asc(quest.id))
    .limit(limit);
  const failed: string[] = [];
  for (const { id } of due) {
    if (await failQuestV2AtDueAt(id, now)) failed.push(id);
  }
  return failed;
};

export const autoApproveDueQuestV2Proofs = async (
  now = new Date(),
  limit = 100
): Promise<string[]> => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const sentBefore = new Date(now.getTime() - proofAutoApprovalWindowMs);
  const due = await db
    .select({
      proofSubmissionId: questV2ProofSubmission.id,
      questId: questV2ProofSubmission.questId,
      hirerId: quest.hirerId,
    })
    .from(questV2ProofSubmission)
    .innerJoin(quest, eq(quest.id, questV2ProofSubmission.questId))
    .where(
      and(
        eq(quest.apiVersion, questApiVersion.v2),
        inArray(quest.questStatus, ['QUEST_IN_PROGRESS', 'QUEST_FAILED']),
        eq(questV2ProofSubmission.submissionStatus, 'PROOF_PENDING'),
        lte(questV2ProofSubmission.sentAt, sentBefore)
      )
    )
    .orderBy(asc(questV2ProofSubmission.sentAt), asc(questV2ProofSubmission.id))
    .limit(limit);
  const approved: string[] = [];
  for (const candidate of due) {
    const result = await reviewQuestV2ProofSubmissionCommand({
      principalId: candidate.hirerId,
      actor: { actorType: 'SYSTEM' },
      operationScope: questV2ProofAutoApprovalOperationScope,
      questId: candidate.questId,
      proofSubmissionId: candidate.proofSubmissionId,
      decision: 'PROOF_APPROVED',
      reason: null,
      commandId: `quest-v2-proof-auto-approval:${candidate.proofSubmissionId}`,
      requestHash: await reviewRequestHashFor(
        candidate.hirerId,
        'auto-approval',
        candidate.questId,
        candidate.proofSubmissionId,
        'PROOF_APPROVED',
        null
      ),
      now,
    });
    if (!('outcome' in result) && !result.replayed) approved.push(candidate.proofSubmissionId);
  }
  return approved;
};

export const autoApproveDueQuestV2CompletionConfirmations = async (
  now = new Date(),
  limit = 100
): Promise<string[]> => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const due = await db
    .select({
      completionConfirmationId: questV2CompletionConfirmation.id,
      questId: questV2CompletionConfirmation.questId,
      hirerId: quest.hirerId,
    })
    .from(questV2CompletionConfirmation)
    .innerJoin(quest, eq(quest.id, questV2CompletionConfirmation.questId))
    .where(
      and(
        eq(quest.apiVersion, questApiVersion.v2),
        inArray(quest.questStatus, ['QUEST_IN_PROGRESS', 'QUEST_FAILED']),
        eq(questV2CompletionConfirmation.reviewStatus, 'COMPLETION_CONFIRMATION_PENDING'),
        lte(questV2CompletionConfirmation.reviewDeadlineAt, now)
      )
    )
    .orderBy(
      asc(questV2CompletionConfirmation.reviewDeadlineAt),
      asc(questV2CompletionConfirmation.id)
    )
    .limit(limit);
  const approved: string[] = [];
  for (const candidate of due) {
    const requestHash = await sha256Json({
      authenticatedMemberId: candidate.hirerId,
      operation: 'completion-auto-approval',
      path: '/api/v2/quests/:questId/completion-confirmations/:completionConfirmationId/review',
      questId: candidate.questId,
      completionConfirmationId: candidate.completionConfirmationId,
      body: { decision: 'COMPLETION_CONFIRMATION_APPROVED', reason: null },
    });
    const result = await db.transaction((transaction) =>
      reviewQuestV2CompletionConfirmationInTransaction(transaction, {
        principalId: candidate.hirerId,
        actor: { actorType: 'SYSTEM' },
        operationScope: questV2CompletionConfirmationAutoApprovalOperationScope,
        questId: candidate.questId,
        completionConfirmationId: candidate.completionConfirmationId,
        decision: 'COMPLETION_CONFIRMATION_APPROVED',
        reason: null,
        commandId: `quest-v2-completion-auto-approval:${candidate.completionConfirmationId}`,
        requestHash,
        now,
      })
    );
    if (!('outcome' in result) && !result.replayed) {
      approved.push(candidate.completionConfirmationId);
    }
  }
  return approved;
};
