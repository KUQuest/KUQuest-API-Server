import { db } from '@/database/client';
import { adminReviewItem } from '@/database/schema/admin.schema';
import { file } from '@/database/schema/file.schema';
import { recordAudit, type AuditActor } from '@/modules/audit/audit.service';
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

import { and, asc, eq, inArray, isNull, isNotNull, lte, ne } from 'drizzle-orm';

import type { QuestTransaction } from './quest-work-chat.port';
import {
  completeQuestCommand,
  findOpenQuestCommandPayloads,
  openQuestCommand,
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './quest-command.service';

import {
  failQuestV2InTransaction,
  settleApprovedQuestV2ProofInTransaction,
  settleProofFreeQuestV2InTransaction,
} from './quest-settlement.service';
import {
  questV2Mode,
  questV2Participation,
  questV2States,
  type QuestV2State,
} from './quest-v2.contract';
import { questV2ProofStorage, type StoredQuestV2ProofFile } from './quest-proof-v2.storage';

export const questV2ProofSubmissionOperationScope = 'quest.v2.proof-submission';

const maxDescriptionLength = 1000;
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

export type QuestV2ProofStatus = (typeof proofStatuses)[number];

export type QuestV2ProofSubmission = {
  id: string;
  questId: string;
  workerId: string | null;
  teamId: string | null;
  submittedByUserId: string;
  description: string | null;
  status: QuestV2ProofStatus | null;
  submittedAt: Date | null;
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
  }>;
  /** Internal marker used by the controller to clean up replay-only uploads. */
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
  fileIds?: string[];
  storedFiles?: StoredQuestV2ProofFileInput[];
  failedFiles?: QuestV2ProofFailedFile[];
  fileFingerprints?: string[];
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
  | 'submission-locked'
  | 'not-v2-contract';

export type ProofCommandOutcomeCode = QuestV2ProofBusinessOutcomeCode | QuestCommandOutcomeCode;

export type QuestV2ProofSubmissionOutcome =
  QuestV2ProofSubmission | { outcome: ProofCommandOutcomeCode };

export type QuestV2ProofSubmissionDeleteOutcome =
  { deleted: true; proofSubmissionId: string } | { outcome: ProofCommandOutcomeCode };

export type QuestV2CompletionConfirmation = {
  confirmed: true;
  confirmedAt: Date;
  questStatus: QuestV2State;
};

export type QuestV2CompletionConfirmationOutcome =
  QuestV2CompletionConfirmation | { outcome: ProofCommandOutcomeCode };

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
  submissionStatus: string | null;
  sentAt: Date | null;
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
  submissionStatus: questV2ProofSubmission.submissionStatus,
  sentAt: questV2ProofSubmission.sentAt,
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
        await questV2ProofStorage.remove(object);
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

const isProofStatus = (value: string | null): value is QuestV2ProofStatus =>
  value !== null && proofStatuses.includes(value as QuestV2ProofStatus);

const isQuestV2State = (value: string): value is QuestV2State =>
  questV2States.includes(value as QuestV2State);

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

const allCompletionObligationsConfirmed = async (
  transaction: QuestTransaction,
  current: QuestRow,
  questId: string
): Promise<boolean> => {
  if (
    current.v2Mode === questV2Mode.candidate &&
    current.v2Participation === questV2Participation.group
  ) {
    const [team] = await transaction
      .select({ id: questCandidateTeamV2.id, leaderId: questCandidateTeamV2.leaderId })
      .from(questCandidateTeamV2)
      .where(
        and(
          eq(questCandidateTeamV2.questId, questId),
          eq(questCandidateTeamV2.state, 'TEAM_SELECTED')
        )
      )
      .limit(1)
      .for('update');
    if (!team) return false;
    const [assignment] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(
        and(
          eq(questAssignment.questId, questId),
          eq(questAssignment.workerId, team.leaderId),
          eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
        )
      )
      .limit(1)
      .for('update');
    if (!assignment) return false;
    const [confirmation] = await transaction
      .select({ id: questV2CompletionConfirmation.id })
      .from(questV2CompletionConfirmation)
      .where(
        and(
          eq(questV2CompletionConfirmation.questId, questId),
          eq(questV2CompletionConfirmation.teamId, team.id)
        )
      )
      .limit(1);
    return Boolean(confirmation);
  }

  const assignments = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE')
      )
    )
    .for('update');
  if (assignments.length === 0) return false;
  const confirmations = await transaction
    .select({ workerId: questV2CompletionConfirmation.workerId })
    .from(questV2CompletionConfirmation)
    .where(
      and(
        eq(questV2CompletionConfirmation.questId, questId),
        inArray(
          questV2CompletionConfirmation.workerId,
          assignments.map(({ workerId }) => workerId)
        )
      )
    );
  const confirmedWorkerIds = new Set(confirmations.map(({ workerId }) => workerId));
  return assignments.every(({ workerId }) => confirmedWorkerIds.has(workerId));
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
    })
    .from(questV2ProofSubmissionFile)
    .leftJoin(file, eq(file.id, questV2ProofSubmissionFile.fileId))
    .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submissionId))
    .orderBy(asc(questV2ProofSubmissionFile.position));

const toSubmission = async (
  database: typeof db | QuestTransaction,
  row: SubmissionRow,
  visibility: 'FULL' | 'SUMMARY' = 'FULL'
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
    status:
      visibility === 'FULL'
        ? (row.submissionStatus as QuestV2ProofStatus | null)
        : (row.submissionStatus as QuestV2ProofStatus),
    submittedAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    visibility,
    fileIds: attachments
      .filter(
        (attachment) => attachment.uploadStatus === 'PROOF_FILE_READY' && attachment.fileId !== null
      )
      .map((attachment) => attachment.fileId!),
    files: attachments,
  };
};

const snapshotFor = (submission: QuestV2ProofSubmission) => ({
  ...submission,
  submittedAt: submission.submittedAt?.toISOString() ?? null,
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
    status: snapshot.status as QuestV2ProofStatus | null,
    submittedAt,
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
});

const completionFromSnapshot = (value: unknown): QuestV2CompletionConfirmation | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const snapshot = value as Partial<QuestV2CompletionConfirmation>;
  const confirmedAt = dateFromSnapshot(snapshot.confirmedAt);
  if (
    snapshot.confirmed !== true ||
    !confirmedAt ||
    typeof snapshot.questStatus !== 'string' ||
    !isQuestV2State(snapshot.questStatus)
  )
    return undefined;
  return { confirmed: true, confirmedAt, questStatus: snapshot.questStatus };
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
        if (input.retryPosition !== undefined) {
          return { kind: 'rejected', rejection: 'invalid-files' };
        }
        const inputFileIds = input.fileIds ?? [];
        const uploadedFiles = input.storedFiles ?? [];
        const failedFiles = input.failedFiles ?? [];
        if (
          description.value === null &&
          inputFileIds.length + uploadedFiles.length + failedFiles.length === 0
        ) {
          return { kind: 'rejected', rejection: 'invalid-draft' };
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
        const existing = await submissionForOwner(transaction, questId, checks.owner);
        if (existing) return { kind: 'rejected', rejection: 'already-exists' };

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
            mergedFiles.readyFiles.length + mergedFiles.failedFiles.length === 0)
        )
          return {
            kind: 'rejected',
            rejection:
              description.value === null &&
              mergedFiles.readyFiles.length + mergedFiles.failedFiles.length === 0
                ? 'invalid-draft'
                : 'invalid-files',
          };
        const [updated] = await transaction
          .update(questV2ProofSubmission)
          .set({
            description: description.value,
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
      return toSubmission(db, row, full ? 'FULL' : 'SUMMARY');
    })
  );
  return submissions.filter(
    (submission): submission is QuestV2ProofSubmission => submission !== undefined
  );
};

export const confirmQuestV2Completion = async (
  memberId: string,
  questId: string,
  rawCommandId: string,
  now = new Date()
): Promise<QuestV2CompletionConfirmationOutcome> => {
  const requestHash = await requestHashFor(memberId, 'confirm-completion', questId, null, null);
  // ADR-0019: the whole command — proof-free check, the confirmation insert, Worker
  // earnings, Assignment completion, the QUEST_COMPLETED transition, and the
  // read-only Work Conversation commit — runs inside this one transaction. The
  // Quest row is locked before runQuestCommand; see the lock-order note there.
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
            confirmedAt: questV2CompletionConfirmation.confirmedAt,
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
          })
          .returning({ confirmedAt: questV2CompletionConfirmation.confirmedAt });
        if (!confirmation)
          throw new Error('Quest API v2 Completion Confirmation insert returned no row');
        let questStatus: QuestV2State = currentQuestState;
        const groupFcfs =
          current.v2Mode === questV2Mode.firstComeFirstServed &&
          current.v2Participation === questV2Participation.group;
        if (groupFcfs) {
          const settlement = await settleProofFreeQuestV2InTransaction(
            transaction,
            questId,
            `quest-v2-completion:${questId}`,
            now,
            checks.owner.workerId!,
            memberId
          );
          if (settlement) questStatus = 'QUEST_COMPLETED';
        } else if (await allCompletionObligationsConfirmed(transaction, current, questId)) {
          await settleProofFreeQuestV2InTransaction(
            transaction,
            questId,
            `quest-v2-completion:${questId}`,
            now
          );
          questStatus = 'QUEST_COMPLETED';
        }
        return {
          kind: 'success',
          result: {
            confirmed: true,
            confirmedAt: confirmation.confirmedAt,
            questStatus,
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

const recordQuestFailureAudit = async (
  transaction: QuestTransaction,
  actor: ReviewCommandActor,
  questId: string,
  now: Date
) =>
  recordAudit(transaction, {
    ...auditActorFor(actor),
    action: 'QUEST_STATE_CHANGED',
    resourceType: 'QUEST',
    resourceId: questId,
    oldValue: { state: 'QUEST_IN_PROGRESS' },
    newValue: { state: 'QUEST_FAILED' },
    createdAt: now,
  });

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

      let questStatus: QuestV2State = current.questState as QuestV2State;
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
        await recordAssignmentAudits(
          transaction,
          input.actor,
          settlement.completedAssignmentIds,
          'ASSIGNMENT_COMPLETED',
          input.now
        );
        await recordAudit(transaction, {
          ...auditActorFor(input.actor),
          action: 'QUEST_REWARD_SETTLED',
          resourceType: 'QUEST_REWARD',
          resourceId: input.questId,
          oldValue: { state: 'QUEST_REWARD_HELD' },
          newValue: {
            state: 'QUEST_REWARD_SETTLED',
            paidSatang: settlement.paidSatang,
            assignmentIds: settlement.completedAssignmentIds,
          },
          createdAt: input.now,
        });
        if (current.questState !== questStatus) {
          await recordAudit(transaction, {
            ...auditActorFor(input.actor),
            action: 'QUEST_STATE_CHANGED',
            resourceType: 'QUEST',
            resourceId: input.questId,
            oldValue: { state: current.questState },
            newValue: { state: questStatus },
            createdAt: input.now,
          });
        }
      } else {
        const failure = await failQuestV2InTransaction(
          transaction,
          input.questId,
          subject.assignmentIds,
          commandId,
          input.now,
          input.actor.actorType === 'MEMBER' ? input.actor.actorUserId : null
        );
        questStatus = failure.questStatus;
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
        if (current.questState === 'QUEST_IN_PROGRESS') {
          await recordQuestFailureAudit(transaction, input.actor, input.questId, input.now);
        }
      }

      return {
        kind: 'success',
        result: { proof, questStatus },
        resourceType: 'quest-v2-proof-command',
        resourceId: proof.id,
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
    .select({ id: questAssignment.id, workerId: questAssignment.workerId })
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
      current.questState !== 'QUEST_IN_PROGRESS' ||
      !current.dueAt ||
      current.dueAt > now
    ) {
      return false;
    }
    const assignmentIds = await dueQuestV2ProofFailureAssignmentIds(transaction, current, questId);
    if (assignmentIds.length === 0) return false;
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
    await recordQuestFailureAudit(transaction, { actorType: 'SYSTEM' }, questId, now);
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
        eq(quest.questStatus, 'QUEST_IN_PROGRESS'),
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
  const sentBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
