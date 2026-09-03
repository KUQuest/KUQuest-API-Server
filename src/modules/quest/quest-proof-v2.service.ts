import { db } from '@/database/client';
import { file } from '@/database/schema/file.schema';
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
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';

import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';

import type { QuestTransaction } from './quest-work-chat.port';
import {
  questV2Mode,
  questV2Participation,
  questV2States,
  type QuestV2State,
} from './quest-v2.contract';
import type { StoredQuestV2ProofFile } from './quest-proof-v2.storage';

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
    fileId: string;
    contentType: string;
    sizeBytes: number;
    position: number;
  }>;
};

export type QuestV2ProofDraftInput = {
  description?: string | null;
  fileIds?: string[];
  storedFiles?: StoredQuestV2ProofFile[];
};

type ProofOwner = {
  workerId: string | null;
  teamId: string | null;
};

type ProofCommandOutcomeCode =
  | 'already-confirmed'
  | 'already-exists'
  | 'already-sent'
  | 'due-at-missing'
  | 'due-at-passed'
  | 'files-required'
  | 'hirer-not-allowed'
  | 'idempotency-in-progress'
  | 'idempotency-key-reused'
  | 'idempotency-unavailable'
  | 'invalid-draft'
  | 'invalid-files'
  | 'invalid-idempotency-key'
  | 'not-authorized'
  | 'not-found'
  | 'not-in-progress'
  | 'not-required'
  | 'proof-not-found'
  | 'submission-locked'
  | 'not-v2-contract';

const proofCommandOutcomeCodes: readonly ProofCommandOutcomeCode[] = [
  'already-confirmed',
  'already-exists',
  'already-sent',
  'due-at-missing',
  'due-at-passed',
  'files-required',
  'hirer-not-allowed',
  'idempotency-in-progress',
  'idempotency-key-reused',
  'idempotency-unavailable',
  'invalid-draft',
  'invalid-files',
  'invalid-idempotency-key',
  'not-authorized',
  'not-found',
  'not-in-progress',
  'not-required',
  'proof-not-found',
  'submission-locked',
  'not-v2-contract',
];

export type QuestV2ProofSubmissionOutcome =
  | QuestV2ProofSubmission
  | { outcome: ProofCommandOutcomeCode };

export type QuestV2ProofSubmissionDeleteOutcome =
  | { deleted: true; proofSubmissionId: string }
  | { outcome: ProofCommandOutcomeCode };

export type QuestV2CompletionConfirmation = {
  confirmed: true;
  confirmedAt: Date;
  questStatus: QuestV2State;
};

export type QuestV2CompletionConfirmationOutcome =
  | QuestV2CompletionConfirmation
  | { outcome: ProofCommandOutcomeCode };

export type QuestV2ProofSubmissionListOutcome =
  | QuestV2ProofSubmission[]
  | { outcome: 'not-authorized' | 'not-found' };

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

type IdempotencyRecord = {
  id: string;
  requestHash: string;
  resourceId: string | null;
  resultData: unknown;
  processingStatus: string;
};

type IdempotencyAcquireResult =
  | { created: true; record: IdempotencyRecord }
  | { created: false; record: IdempotencyRecord }
  | { outcome: Extract<ProofCommandOutcomeCode, `idempotency-${string}`> };

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

const idempotencyFields = {
  id: walletIdempotencyKey.id,
  requestHash: walletIdempotencyKey.requestHash,
  resourceId: walletIdempotencyKey.resourceId,
  resultData: walletIdempotencyKey.resultData,
  processingStatus: walletIdempotencyKey.processingStatus,
};

const sha256Json = async (value: object): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
};

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const isProofStatus = (value: string | null): value is QuestV2ProofStatus =>
  value !== null && proofStatuses.includes(value as QuestV2ProofStatus);

const isQuestV2State = (value: string): value is QuestV2State =>
  questV2States.includes(value as QuestV2State);

const isInputFieldPresent = <T extends object, K extends keyof T>(input: T, field: K): boolean =>
  Object.prototype.hasOwnProperty.call(input, field);

const normalizedDescription = (
  value: string | null | undefined,
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
  questId: string,
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

const acquireIdempotency = async (
  transaction: QuestTransaction,
  memberId: string,
  key: string,
  requestHash: string,
): Promise<IdempotencyAcquireResult> => {
  const [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: memberId,
      operationScope: questV2ProofSubmissionOperationScope,
      key,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning(idempotencyFields);
  if (created) return { created: true, record: created };

  const [existing] = await transaction
    .select(idempotencyFields)
    .from(walletIdempotencyKey)
    .where(and(
      eq(walletIdempotencyKey.principalUserId, memberId),
      eq(walletIdempotencyKey.operationScope, questV2ProofSubmissionOperationScope),
      eq(walletIdempotencyKey.key, key),
    ))
    .limit(1)
    .for('update');
  if (!existing) return { outcome: 'idempotency-unavailable' };
  if (existing.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (existing.processingStatus === 'COMPLETED') return { created: false, record: existing };
  return { outcome: 'idempotency-in-progress' };
};

const completeIdempotency = async (
  transaction: QuestTransaction,
  idempotencyId: string,
  resourceId: string | null,
  resultData: object,
  now: Date,
) => {
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-v2-proof-submission',
      resourceId,
      resultData,
      processingStatus: 'COMPLETED',
      completedAt: now,
    })
    .where(eq(walletIdempotencyKey.id, idempotencyId));
};

const outcomeFromSnapshot = (
  value: unknown,
): { outcome: ProofCommandOutcomeCode } | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const outcome = (value as Record<string, unknown>).outcome;
  return typeof outcome === 'string' && proofCommandOutcomeCodes.includes(outcome as ProofCommandOutcomeCode)
    ? { outcome: outcome as ProofCommandOutcomeCode }
    : undefined;
};

const ownerCondition = (owner: ProofOwner) => owner.workerId
  ? eq(questV2ProofSubmission.workerId, owner.workerId)
  : eq(questV2ProofSubmission.teamId, owner.teamId!);

const ownerFor = async (
  transaction: QuestTransaction,
  current: QuestRow,
  questId: string,
  memberId: string,
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
        eq(questCandidateTeamV2Member.teamId, questCandidateTeamV2.id),
      )
      .where(and(
        eq(questCandidateTeamV2.questId, questId),
        eq(questCandidateTeamV2.leaderId, memberId),
        eq(questCandidateTeamV2Member.memberId, memberId),
        eq(questCandidateTeamV2.state, 'TEAM_SELECTED'),
      ))
      .limit(1)
      .for('update');
    if (!team) return undefined;

    const [assignment] = await transaction
      .select({ id: questAssignment.id })
      .from(questAssignment)
      .where(and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.workerId, memberId),
        eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
      ))
      .limit(1)
      .for('update');
    return assignment ? { workerId: null, teamId: team.id } : undefined;
  }

  const [assignment] = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(and(
      eq(questAssignment.questId, questId),
      eq(questAssignment.workerId, memberId),
      eq(questAssignment.assignmentStatus, 'ASSIGNMENT_ACTIVE'),
    ))
    .limit(1)
    .for('update');
  return assignment ? { workerId: memberId, teamId: null } : undefined;
};

const submissionForOwner = async (
  transaction: QuestTransaction,
  questId: string,
  owner: ProofOwner,
): Promise<SubmissionRow | undefined> => {
  const [submission] = await transaction
    .select(submissionFields)
    .from(questV2ProofSubmission)
    .where(and(
      eq(questV2ProofSubmission.questId, questId),
      ownerCondition(owner),
    ))
    .limit(1)
    .for('update');
  return submission;
};

const attachmentRowsFor = async (
  database: typeof db | QuestTransaction,
  submissionId: string,
) => database
  .select({
    fileId: questV2ProofSubmissionFile.fileId,
    contentType: file.contentType,
    sizeBytes: file.sizeBytes,
    position: questV2ProofSubmissionFile.position,
  })
  .from(questV2ProofSubmissionFile)
  .innerJoin(file, eq(file.id, questV2ProofSubmissionFile.fileId))
  .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submissionId))
  .orderBy(asc(questV2ProofSubmissionFile.position));

const toSubmission = async (
  database: typeof db | QuestTransaction,
  row: SubmissionRow,
  visibility: 'FULL' | 'SUMMARY' = 'FULL',
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
    status: visibility === 'FULL' ? row.submissionStatus as QuestV2ProofStatus | null : row.submissionStatus as QuestV2ProofStatus,
    submittedAt: row.sentAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    visibility,
    fileIds: attachments.map((attachment) => attachment.fileId),
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
    (snapshot.status !== null && (typeof snapshot.status !== 'string' || !isProofStatus(snapshot.status))) ||
    (snapshot.submittedAt !== null && typeof snapshot.submittedAt !== 'string') ||
    !Array.isArray(snapshot.fileIds) ||
    !Array.isArray(snapshot.files) ||
    snapshot.visibility !== 'FULL'
  ) return undefined;
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

const requestHashFor = (
  memberId: string,
  operation: string,
  questId: string,
  proofSubmissionId: string | null,
  input: QuestV2ProofDraftInput | null,
): Promise<string> => sha256Json({
  authenticatedMemberId: memberId,
  operation,
  path: proofSubmissionId
    ? '/api/v2/quests/:questId/proof-submissions/:proofSubmissionId'
    : '/api/v2/quests/:questId/proof-submissions',
  questId,
  proofSubmissionId,
  body: input
    ? {
        description: input.description ?? null,
        fileIds: input.fileIds ?? null,
        storedFiles: input.storedFiles?.map((stored) => ({
          bucket: stored.bucket,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          sizeBytes: stored.sizeBytes,
          fileName: stored.fileName,
        })) ?? null,
      }
    : {},
});

const validateStoredFiles = (storedFiles: StoredQuestV2ProofFile[]): boolean =>
  storedFiles.length <= maxProofFiles && storedFiles.every((stored) =>
    allowedAttachmentContentTypes.has(stored.contentType) &&
    Number.isInteger(stored.sizeBytes) &&
    stored.sizeBytes > 0 &&
    stored.sizeBytes <= maxAttachmentSizeBytes,
  );

const validateFileIds = async (
  transaction: QuestTransaction,
  memberId: string,
  fileIds: string[],
): Promise<boolean> => {
  if (fileIds.length > maxProofFiles || new Set(fileIds).size !== fileIds.length) return false;
  if (fileIds.length === 0) return true;
  const rows = await transaction
    .select({ id: file.id, contentType: file.contentType, sizeBytes: file.sizeBytes })
    .from(file)
    .where(and(
      inArray(file.id, fileIds),
      eq(file.uploadedByUserId, memberId),
      isNull(file.deletedAt),
    ));
  return rows.length === fileIds.length && rows.every((row) =>
    allowedAttachmentContentTypes.has(row.contentType) &&
    Number.isInteger(row.sizeBytes) &&
    row.sizeBytes > 0 &&
    row.sizeBytes <= maxAttachmentSizeBytes,
  );
};

const currentFileIds = async (
  transaction: QuestTransaction,
  submissionId: string,
): Promise<string[]> => (await transaction
  .select({ fileId: questV2ProofSubmissionFile.fileId })
  .from(questV2ProofSubmissionFile)
  .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submissionId))
  .orderBy(asc(questV2ProofSubmissionFile.position)))
  .map((row) => row.fileId);

const persistStoredFiles = async (
  transaction: QuestTransaction,
  memberId: string,
  storedFiles: StoredQuestV2ProofFile[],
): Promise<string[]> => {
  if (storedFiles.length === 0) return [];
  const values = storedFiles.map((stored) => ({
    id: crypto.randomUUID(),
    bucket: stored.bucket,
    objectKey: stored.objectKey,
    contentType: stored.contentType,
    sizeBytes: stored.sizeBytes,
    uploadedByUserId: memberId,
  }));
  await transaction.insert(file).values(values);
  return values.map((value) => value.id);
};

const replaceAttachments = async (
  transaction: QuestTransaction,
  submissionId: string,
  fileIds: string[],
  now: Date,
) => {
  await transaction
    .delete(questV2ProofSubmissionFile)
    .where(eq(questV2ProofSubmissionFile.proofSubmissionId, submissionId));
  if (fileIds.length === 0) return;
  await transaction.insert(questV2ProofSubmissionFile).values(fileIds.map((fileId, position) => ({
    proofSubmissionId: submissionId,
    fileId,
    position,
    attachedAt: now,
  })));
};

const prepareFileIds = async (
  transaction: QuestTransaction,
  memberId: string,
  fileIds: string[],
  storedFiles: StoredQuestV2ProofFile[],
): Promise<{ fileIds: string[]; storedFiles: StoredQuestV2ProofFile[] } | { outcome: 'invalid-files' }> => {
  if (
    fileIds.length + storedFiles.length > maxProofFiles ||
    new Set(fileIds).size !== fileIds.length ||
    !validateStoredFiles(storedFiles) ||
    !(await validateFileIds(transaction, memberId, fileIds))
  ) return { outcome: 'invalid-files' };
  return { fileIds, storedFiles };
};

const commandSetup = async (
  transaction: QuestTransaction,
  memberId: string,
  questId: string,
  commandId: string,
  requestHash: string,
): Promise<
  | { outcome: 'not-found' | Extract<ProofCommandOutcomeCode, `idempotency-${string}`> }
  | { current: QuestRow; idempotency: Exclude<IdempotencyAcquireResult, { outcome: string }> }
> => {
  const current = await lockQuest(transaction, questId);
  if (!current) return { outcome: 'not-found' as const };
  const idempotency = await acquireIdempotency(transaction, memberId, commandId, requestHash);
  if ('outcome' in idempotency) return { outcome: idempotency.outcome };
  return { current, idempotency };
};

const commandFailure = async (
  transaction: QuestTransaction,
  idempotencyId: string,
  outcome: ProofCommandOutcomeCode,
  now: Date,
) => {
  await completeIdempotency(transaction, idempotencyId, null, { outcome }, now);
  return { outcome } as const;
};

const replaySubmission = (record: IdempotencyRecord): QuestV2ProofSubmissionOutcome =>
  submissionFromSnapshot(record.resultData) ?? outcomeFromSnapshot(record.resultData) ?? {
    outcome: 'idempotency-unavailable',
  };

const writeCommandChecks = async (
  transaction: QuestTransaction,
  current: QuestRow,
  memberId: string,
  questId: string,
  now: Date,
): Promise<
  | { owner: ProofOwner }
  | { outcome: Extract<ProofCommandOutcomeCode, 'due-at-missing' | 'due-at-passed' | 'hirer-not-allowed' | 'not-authorized' | 'not-in-progress' | 'not-v2-contract'> }
> => {
  if (current.hirerId === memberId) return { outcome: 'hirer-not-allowed' as const };
  if (!current.v2Mode || !current.v2Participation) return { outcome: 'not-v2-contract' as const };
  if (current.questState !== 'QUEST_IN_PROGRESS') return { outcome: 'not-in-progress' as const };
  if (!current.dueAt) return { outcome: 'due-at-missing' as const };
  if (current.dueAt.getTime() <= now.getTime()) return { outcome: 'due-at-passed' as const };
  const owner = await ownerFor(transaction, current, questId, memberId);
  return owner ? { owner } : { outcome: 'not-authorized' as const };
};

export const createQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  input: QuestV2ProofDraftInput,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2ProofSubmissionOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(memberId, 'create', questId, null, input);

  return db.transaction(async (transaction) => {
    const setup = await commandSetup(transaction, memberId, questId, commandId, requestHash);
    if ('outcome' in setup) return setup;
    if (!setup.idempotency.created) return replaySubmission(setup.idempotency.record);

    const fail = (outcome: ProofCommandOutcomeCode) =>
      commandFailure(transaction, setup.idempotency.record.id, outcome, now);
    if (!setup.current.proofRequired) return fail('not-required');
    const checks = await writeCommandChecks(transaction, setup.current, memberId, questId, now);
    if ('outcome' in checks) return fail(checks.outcome);
    const description = normalizedDescription(input.description);
    if ('outcome' in description) return fail(description.outcome);
    const inputFileIds = input.fileIds ?? [];
    const storedFiles = input.storedFiles ?? [];
    if (description.value === null && inputFileIds.length + storedFiles.length === 0) {
      return fail('invalid-draft');
    }
    const preparedFiles = await prepareFileIds(transaction, memberId, inputFileIds, storedFiles);
    if ('outcome' in preparedFiles) return fail(preparedFiles.outcome);
    const existing = await submissionForOwner(transaction, questId, checks.owner);
    if (existing) return fail('already-exists');

    const storedFileIds = await persistStoredFiles(transaction, memberId, preparedFiles.storedFiles);
    const allFileIds = [...preparedFiles.fileIds, ...storedFileIds];
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
    if (!created) return fail('idempotency-unavailable');
    await replaceAttachments(transaction, created.id, allFileIds, now);
    const submission = await toSubmission(transaction, created);
    await completeIdempotency(
      transaction,
      setup.idempotency.record.id,
      submission.id,
      snapshotFor(submission),
      now,
    );
    return submission;
  });
};

export const editQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  input: QuestV2ProofDraftInput,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2ProofSubmissionOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(memberId, 'edit', questId, proofSubmissionId, input);

  return db.transaction(async (transaction) => {
    const setup = await commandSetup(transaction, memberId, questId, commandId, requestHash);
    if ('outcome' in setup) return setup;
    if (!setup.idempotency.created) return replaySubmission(setup.idempotency.record);

    const fail = (outcome: ProofCommandOutcomeCode) =>
      commandFailure(transaction, setup.idempotency.record.id, outcome, now);
    if (!setup.current.proofRequired) return fail('not-required');
    const checks = await writeCommandChecks(transaction, setup.current, memberId, questId, now);
    if ('outcome' in checks) return fail(checks.outcome);
    const submission = await submissionForOwner(transaction, questId, checks.owner);
    if (!submission || submission.id !== proofSubmissionId || submission.submittedByUserId !== memberId) {
      return fail('proof-not-found');
    }
    if (submission.submissionStatus !== null) return fail('submission-locked');

    const description = isInputFieldPresent(input, 'description')
      ? normalizedDescription(input.description)
      : { value: submission.description };
    if ('outcome' in description) return fail(description.outcome);
    const existingFileIds = await currentFileIds(transaction, submission.id);
    const requestedFileIds = isInputFieldPresent(input, 'fileIds')
      ? input.fileIds ?? []
      : existingFileIds;
    const storedFiles = input.storedFiles ?? [];
    const fileIdsToValidate = storedFiles.length > 0 && !isInputFieldPresent(input, 'fileIds')
      ? existingFileIds
      : requestedFileIds;
    if (
      description.value === null &&
      fileIdsToValidate.length + storedFiles.length === 0
    ) return fail('invalid-draft');
    const preparedFiles = await prepareFileIds(transaction, memberId, fileIdsToValidate, storedFiles);
    if ('outcome' in preparedFiles) return fail(preparedFiles.outcome);
    const storedFileIds = await persistStoredFiles(transaction, memberId, preparedFiles.storedFiles);
    const allFileIds = [...preparedFiles.fileIds, ...storedFileIds];
    const [updated] = await transaction
      .update(questV2ProofSubmission)
      .set({
        description: description.value,
        updatedAt: now,
      })
      .where(eq(questV2ProofSubmission.id, submission.id))
      .returning(submissionFields);
    if (!updated) return fail('idempotency-unavailable');
    await replaceAttachments(transaction, updated.id, allFileIds, now);
    const result = await toSubmission(transaction, updated);
    await completeIdempotency(
      transaction,
      setup.idempotency.record.id,
      result.id,
      snapshotFor(result),
      now,
    );
    return result;
  });
};

export const deleteQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2ProofSubmissionDeleteOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(memberId, 'delete', questId, proofSubmissionId, null);

  return db.transaction(async (transaction) => {
    const setup = await commandSetup(transaction, memberId, questId, commandId, requestHash);
    if ('outcome' in setup) return setup;
    if (!setup.idempotency.created) {
      const snapshot = setup.idempotency.record.resultData;
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        const deleted = snapshot as { deleted?: unknown; proofSubmissionId?: unknown };
        if (deleted.deleted === true && typeof deleted.proofSubmissionId === 'string') {
          return { deleted: true, proofSubmissionId: deleted.proofSubmissionId };
        }
      }
      return outcomeFromSnapshot(snapshot) ?? { outcome: 'idempotency-unavailable' };
    }

    const fail = (outcome: ProofCommandOutcomeCode) =>
      commandFailure(transaction, setup.idempotency.record.id, outcome, now);
    if (!setup.current.proofRequired) return fail('not-required');
    const checks = await writeCommandChecks(transaction, setup.current, memberId, questId, now);
    if ('outcome' in checks) return fail(checks.outcome);
    const submission = await submissionForOwner(transaction, questId, checks.owner);
    if (!submission || submission.id !== proofSubmissionId || submission.submittedByUserId !== memberId) {
      return fail('proof-not-found');
    }
    if (submission.submissionStatus !== null) return fail('submission-locked');
    await transaction
      .delete(questV2ProofSubmission)
      .where(eq(questV2ProofSubmission.id, proofSubmissionId));
    const result = { deleted: true as const, proofSubmissionId };
    await completeIdempotency(
      transaction,
      setup.idempotency.record.id,
      proofSubmissionId,
      result,
      now,
    );
    return result;
  });
};

export const submitQuestV2ProofSubmission = async (
  memberId: string,
  questId: string,
  proofSubmissionId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2ProofSubmissionOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(memberId, 'submit', questId, proofSubmissionId, null);

  return db.transaction(async (transaction) => {
    const setup = await commandSetup(transaction, memberId, questId, commandId, requestHash);
    if ('outcome' in setup) return setup;
    if (!setup.idempotency.created) return replaySubmission(setup.idempotency.record);

    const fail = (outcome: ProofCommandOutcomeCode) =>
      commandFailure(transaction, setup.idempotency.record.id, outcome, now);
    if (!setup.current.proofRequired) return fail('not-required');
    const checks = await writeCommandChecks(transaction, setup.current, memberId, questId, now);
    if ('outcome' in checks) return fail(checks.outcome);
    const submission = await submissionForOwner(transaction, questId, checks.owner);
    if (!submission || submission.id !== proofSubmissionId || submission.submittedByUserId !== memberId) {
      return fail('proof-not-found');
    }
    if (submission.submissionStatus !== null) return fail('already-sent');
    const attachments = await attachmentRowsFor(transaction, submission.id);
    if (attachments.length === 0) return fail('files-required');
    const [sent] = await transaction
      .update(questV2ProofSubmission)
      .set({
        submissionStatus: 'PROOF_PENDING',
        sentAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(questV2ProofSubmission.id, submission.id),
        isNull(questV2ProofSubmission.submissionStatus),
      ))
      .returning(submissionFields);
    if (!sent) return fail('already-sent');
    const result = await toSubmission(transaction, sent);
    await completeIdempotency(
      transaction,
      setup.idempotency.record.id,
      result.id,
      snapshotFor(result),
      now,
    );
    return result;
  });
};

export const listQuestV2ProofSubmissions = async (
  memberId: string,
  questId: string,
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
      .where(and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.workerId, memberId),
        ne(questAssignment.assignmentStatus, 'ASSIGNMENT_CANCELLED'),
      ))
      .limit(1);
    if (!assignment) return { outcome: 'not-authorized' };
  }

  const rows = await db
    .select(submissionFields)
    .from(questV2ProofSubmission)
    .where(eq(questV2ProofSubmission.questId, questId))
    .orderBy(asc(questV2ProofSubmission.createdAt), asc(questV2ProofSubmission.id));
  const submissions = await Promise.all(rows.map(async (row) => {
    const full = current.hirerId === memberId || row.submittedByUserId === memberId;
    if (!full && row.sentAt === null) return undefined;
    return toSubmission(db, row, full ? 'FULL' : 'SUMMARY');
  }));
  return submissions.filter((submission): submission is QuestV2ProofSubmission => submission !== undefined);
};

export const confirmQuestV2Completion = async (
  memberId: string,
  questId: string,
  rawCommandId: string,
  now = new Date(),
): Promise<QuestV2CompletionConfirmationOutcome> => {
  const commandId = rawCommandId.trim();
  if (commandId.length === 0 || commandId.length > 200) return { outcome: 'invalid-idempotency-key' };
  const requestHash = await requestHashFor(memberId, 'confirm-completion', questId, null, null);

  return db.transaction(async (transaction) => {
    const setup = await commandSetup(transaction, memberId, questId, commandId, requestHash);
    if ('outcome' in setup) return setup;
    if (!setup.idempotency.created) {
      const snapshot = setup.idempotency.record.resultData;
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        const value = snapshot as Partial<QuestV2CompletionConfirmation>;
        const confirmedAt = dateFromSnapshot(value.confirmedAt);
        if (value.confirmed === true && confirmedAt && typeof value.questStatus === 'string' && isQuestV2State(value.questStatus)) {
          return { confirmed: true as const, confirmedAt, questStatus: value.questStatus };
        }
      }
      return outcomeFromSnapshot(snapshot) ?? { outcome: 'idempotency-unavailable' };
    }

    const fail = (outcome: ProofCommandOutcomeCode) =>
      commandFailure(transaction, setup.idempotency.record.id, outcome, now);
    if (setup.current.proofRequired) return fail('not-required');
    const checks = await writeCommandChecks(transaction, setup.current, memberId, questId, now);
    if ('outcome' in checks) return fail(checks.outcome);
    const [existing] = await transaction
      .select({ id: questV2CompletionConfirmation.id, confirmedAt: questV2CompletionConfirmation.confirmedAt })
      .from(questV2CompletionConfirmation)
      .where(and(
        eq(questV2CompletionConfirmation.questId, questId),
        checks.owner.workerId
          ? eq(questV2CompletionConfirmation.workerId, checks.owner.workerId)
          : eq(questV2CompletionConfirmation.teamId, checks.owner.teamId!),
      ))
      .limit(1)
      .for('update');
    if (existing) return fail('already-confirmed');
    if (!isQuestV2State(setup.current.questState)) return fail('not-v2-contract');
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
    if (!confirmation) return fail('idempotency-unavailable');
    const result = {
      confirmed: true as const,
      confirmedAt: confirmation.confirmedAt,
      questStatus: setup.current.questState,
    };
    await completeIdempotency(
      transaction,
      setup.idempotency.record.id,
      null,
      { ...result, confirmedAt: result.confirmedAt.toISOString() },
      now,
    );
    return result;
  });
};
