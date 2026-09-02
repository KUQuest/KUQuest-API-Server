import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { file } from '@/database/schema/file.schema';
import {
  quest,
  questApplication,
  questAssignment,
  questApiVersion,
  questEditHistory,
  questEditRequest,
  questEditRequestResponse,
  questImage,
  questLocation,
  questTeam,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  getEffectiveFundingReservationPolicy,
  reserveSpending,
} from '@/modules/wallet';
import {
  decodeCursor,
  encodeCursor,
  parsePageLimit,
  type CursorPayload,
} from '@/shared/cursor';

import { and, asc, eq, exists, gt, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  buildQuestPublishCheck,
  calculateQuestEscrowRequirementSatang,
  type QuestPublishCheck,
  type QuestPublishSnapshot,
} from './quest.publish.policy';
import { softDeleteQuestImageAndRepack } from './quest-image.service';
import {
  applicationStatus,
  assignmentStatus,
  questParticipation,
  questStatus,
  teamStatus,
  type QuestMode,
  type QuestParticipation,
  type QuestStatus,
} from './quest.contract';
import { maxQuestImages } from './quest.schema';
import type { QuestCreateInput, QuestEditInput } from './quest.schema';
import type { StoredQuestImage } from './quest.storage';

type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuestDatabase = typeof db | QuestTransaction;

type QuestPublishRow = {
  id: string;
  questStatus: QuestStatus;
  tagId: string | null;
  rewardSatang: number;
  headcount: number;
  startTime: Date;
  dueAt: Date | null;
};

export type QuestPublishOutcome =
  | {
      outcome: 'published';
      reservationId: string;
      policyRevisionId: string;
      policyRevision: number;
      platformFeeBps: number;
      platformFeePerWorkerSatang: number;
      questEscrowSatang: number;
    }
  | { outcome: 'not-draft' }
  | { outcome: 'blocked'; check: QuestPublishCheck };

type QuestRow = {
  id: string;
  title: string;
  description: string | null;
  condition: string;
  rewardSatang: number | null;
  tagId: string | null;
  tagName: string | null;
  mode: QuestMode;
  participation: QuestParticipation;
  questStatus: QuestStatus;
  headcount: number;
  startTime: Date;
  dueAt: Date | null;
  proofRequired: boolean;
  hirerFirstName: string;
  hirerLastName: string;
};

type LocationRow = {
  questId: string;
  label: string | null;
};

const questLocationSelection = {
  questId: questLocation.questId,
  label: questLocation.label,
};

export type QuestImage = {
  fileId: string;
  position: number;
  bucket: string;
  objectKey: string;
};

export type QuestImageMutationOutcome = {
  outcome: 'not-found' | 'not-editable' | 'limit-reached';
};

export type AddQuestImagesOutcome =
  | { images: QuestImage[] }
  | QuestImageMutationOutcome;

export type QuestEditOutcome =
  | { id: string }
  | {
      outcome:
        | 'empty-edit'
        | 'invalid-dates'
        | 'not-found'
        | 'not-editable'
        | 'requires-consent'
        | 'tag-not-found'
        | 'tag-required'
        | 'forbidden-fields';
    };

export type QuestEditRequestOutcome =
  | { requestId: string; status: 'EDIT_REQUEST_PENDING'; expiresAt: Date }
  | { outcome: 'empty-edit' | 'not-found' | 'not-editable' | 'pending-request' | 'forbidden-fields' | 'invalid-dates' | 'invalid-files' };

export type QuestEditResponseOutcome =
  | { status: 'EDIT_REQUEST_PENDING' | 'EDIT_REQUEST_APPROVED' | 'EDIT_REQUEST_REJECTED'; requestId: string }
  | { outcome: 'not-found' | 'not-authorized' | 'already-responded' | 'expired' | 'not-pending' | 'invalid-files' };

type QuestEditRow = {
  id: string;
  title: string;
  description: string | null;
  condition: string;
  tagId: string | null;
  questStatus: QuestStatus;
  startTime: Date;
  dueAt: Date | null;
  proofRequired: boolean;
};

type QuestEditLocation = {
  label: string | null;
};

const selectQuestImages = async (
  database: QuestDatabase,
  questId: string,
): Promise<QuestImage[]> => {
  const rows = await database
    .select({
      fileId: questImage.fileId,
      position: questImage.position,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(questImage)
    .innerJoin(file, and(eq(questImage.fileId, file.id), isNull(file.deletedAt)))
    .where(eq(questImage.questId, questId))
    .orderBy(asc(questImage.position));

  return rows;
};

const selectQuestLocations = async (
  database: QuestDatabase,
  questId: string,
): Promise<LocationRow[]> => {
  const rows = await database
    .select(questLocationSelection)
    .from(questLocation)
    .where(eq(questLocation.questId, questId))
    .orderBy(asc(questLocation.id));

  return rows;
};

const selectOwnedQuestForEdit = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
): Promise<QuestEditRow | undefined> => {
  const [ownedQuest] = await transaction
    .select({
      id: quest.id,
      title: quest.title,
      description: quest.description,
      condition: quest.condition,
      tagId: quest.tagId,
      questStatus: quest.questStatus,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
      proofRequired: quest.proofRequired,
    })
    .from(quest)
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.hirerId, userId),
        eq(quest.apiVersion, questApiVersion.v1),
      ),
    )
    .limit(1)
    .for('update');

  return ownedQuest;
};

const getQuestEditEligibility = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
): Promise<
  | { outcome: 'not-found' | 'not-editable' | 'requires-consent' }
  | { quest: QuestEditRow }
> => {
  const ownedQuest = await selectOwnedQuestForEdit(transaction, userId, questId);
  if (!ownedQuest) return { outcome: 'not-found' };

  const applications = await transaction
    .select({ applicationStatus: questApplication.applicationStatus })
    .from(questApplication)
    .where(eq(questApplication.questId, questId));
  const teams = await transaction
    .select({ teamStatus: questTeam.teamStatus })
    .from(questTeam)
    .where(eq(questTeam.questId, questId));
  const assignments = await transaction
    .select({ id: questAssignment.id })
    .from(questAssignment)
    .where(
      and(
        eq(questAssignment.questId, questId),
        eq(questAssignment.assignmentStatus, assignmentStatus.active),
      ),
    );

  const hasSelectedParticipation =
    applications.some(({ applicationStatus: status }) => status === applicationStatus.selected) ||
    teams.some(({ teamStatus: status }) => status === teamStatus.selected) ||
    assignments.length > 0;
  if (hasSelectedParticipation) return { outcome: 'requires-consent' };
  if (ownedQuest.questStatus !== questStatus.draft && ownedQuest.questStatus !== questStatus.open) {
    return { outcome: 'not-editable' };
  }

  const hasCandidate =
    applications.some(({ applicationStatus: status }) => status === applicationStatus.applied) ||
    teams.some(
      ({ teamStatus: status }) =>
        status === teamStatus.forming || status === teamStatus.submitted,
    );
  if (hasCandidate) return { outcome: 'not-editable' };

  return { quest: ownedQuest };
};

const lockOwnedQuest = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
) => {
  const [ownedQuest] = await transaction
    .select({ id: quest.id, questStatus: quest.questStatus })
    .from(quest)
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.hirerId, userId),
        eq(quest.apiVersion, questApiVersion.v1),
      ),
    )
    .limit(1)
    .for('update');

  return ownedQuest;
};

const checkQuestImageUploadInTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  imageCountToAdd: number,
): Promise<QuestImageMutationOutcome | { currentCount: number }> => {
  const ownedQuest = await lockOwnedQuest(transaction, userId, questId);

  if (!ownedQuest) return { outcome: 'not-found' };
  if (ownedQuest.questStatus !== questStatus.draft) return { outcome: 'not-editable' };

  const [imageCount] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questImage)
    .where(eq(questImage.questId, questId));
  const currentCount = Number(imageCount?.count ?? 0);

  return currentCount + imageCountToAdd > maxQuestImages
    ? { outcome: 'limit-reached' }
    : { currentCount };
};

export type QuestListFilters = {
  q?: string;
  tagId?: string;
  mode?: QuestMode;
  participation?: QuestParticipation;
  maxDurationMinutes?: number;
  minReward?: number;
  maxReward?: number;
  startFrom?: Date;
  startTo?: Date;
  limit?: number;
  cursor?: string;
};

export type QuestCreateOutcome =
  | { id: string }
  | { outcome: 'tag-not-found' | 'invalid-dates' | 'invalid-headcount' };

const toRewardBaht = (rewardSatang: number) => Math.trunc(rewardSatang / 100);

const requireQuestReward = (rewardSatang: number | null): number => {
  if (rewardSatang === null) throw new Error('Quest Reward is missing');
  return rewardSatang;
};

const durationMinutes = (startTime: Date, dueAt: Date | null) => {
  if (!dueAt) return null;

  return Math.max(1, Math.round((dueAt.getTime() - startTime.getTime()) / 60_000));
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

const hirerName = (row: Pick<QuestRow, 'hirerFirstName' | 'hirerLastName'>) =>
  `${row.hirerFirstName} ${row.hirerLastName}`.trim();

const toLocation = (location: LocationRow) => ({
  label: location.label,
});

const groupLocations = (locations: LocationRow[]) => {
  const grouped = new Map<string, LocationRow[]>();

  for (const location of locations) {
    const current = grouped.get(location.questId) ?? [];
    current.push(location);
    grouped.set(location.questId, current);
  }

  return grouped;
};

const loadLocations = async (questIds: string[]) => {
  if (questIds.length === 0) return new Map<string, LocationRow[]>();

  const locations = await db
    .select(questLocationSelection)
    .from(questLocation)
    .where(inArray(questLocation.questId, questIds))
    .orderBy(asc(questLocation.id));

  return groupLocations(locations);
};

const buildCursorCondition = (cursor: CursorPayload | undefined) => {
  if (!cursor) return undefined;

  const startTime = new Date(cursor.startTime);
  return or(
    gt(quest.startTime, startTime),
    and(eq(quest.startTime, startTime), gt(quest.id, cursor.id)),
  );
};

const listRows = async (filters: QuestListFilters, hirerId?: string) => {
  const limit = parsePageLimit(filters.limit);
  const cursor = decodeCursor(filters.cursor);
  const conditions = [
    eq(quest.apiVersion, questApiVersion.v1),
    hirerId ? eq(quest.hirerId, hirerId) : eq(quest.questStatus, questStatus.open),
  ];

  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    conditions.push(
      sql`(${quest.title} ILIKE ${pattern} ESCAPE ${'\\'} OR ${quest.description} ILIKE ${pattern} ESCAPE ${'\\'})`,
    );
  }
  if (filters.tagId) conditions.push(eq(quest.tagId, filters.tagId));
  if (filters.mode) conditions.push(eq(quest.mode, filters.mode));
  if (filters.participation) conditions.push(eq(quest.participation, filters.participation));
  if (filters.minReward !== undefined) {
    conditions.push(sql`${quest.rewardSatang} >= ${filters.minReward * 100}`);
  }
  if (filters.maxReward !== undefined) {
    conditions.push(sql`${quest.rewardSatang} <= ${filters.maxReward * 100}`);
  }
  if (filters.startFrom) conditions.push(sql`${quest.startTime} >= ${filters.startFrom}`);
  if (filters.startTo) conditions.push(sql`${quest.startTime} <= ${filters.startTo}`);
  if (filters.maxDurationMinutes !== undefined) {
    conditions.push(
      sql`${quest.dueAt} IS NOT NULL AND GREATEST(1, ROUND(EXTRACT(EPOCH FROM (${quest.dueAt} - ${quest.startTime})) / 60)) <= ${filters.maxDurationMinutes}`,
    );
  }

  const cursorCondition = buildCursorCondition(cursor);
  if (cursorCondition) conditions.push(cursorCondition);

  const rows = await db
    .select({
      id: quest.id,
      title: quest.title,
      description: quest.description,
      condition: quest.condition,
      rewardSatang: quest.rewardSatang,
      tagId: tag.id,
      tagName: tag.name,
      mode: quest.mode,
      participation: quest.participation,
      questStatus: quest.questStatus,
      headcount: quest.headcount,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
      proofRequired: quest.proofRequired,
      hirerFirstName: authUser.firstName,
      hirerLastName: authUser.lastName,
    })
    .from(quest)
    .innerJoin(authUser, eq(quest.hirerId, authUser.id))
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(and(...conditions))
    .orderBy(asc(quest.startTime), asc(quest.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const locations = await loadLocations(page.map((row) => row.id));

  return {
    rows: page,
    locations,
    hasMore,
    limit,
  };
};

const serializeCard = (
  row: QuestRow,
  locations: Map<string, LocationRow[]>,
) => {
  const firstLocation = locations.get(row.id)?.[0];
  const location = firstLocation ? toLocation(firstLocation) : null;

  return {
    id: row.id,
    title: row.title,
    reward: toRewardBaht(requireQuestReward(row.rewardSatang)),
    tag: row.tagId && row.tagName ? { id: row.tagId, name: row.tagName } : null,
    mode: row.mode,
    participation: row.participation,
    headcount: row.headcount,
    startTime: row.startTime.toISOString(),
    estimatedDurationMinutes: durationMinutes(row.startTime, row.dueAt),
    hirerName: hirerName(row),
    location,
  };
};

const serializeBoardCard = (
  row: QuestRow,
  locations: Map<string, LocationRow[]>,
) => {
  const card = serializeCard(row, locations);
  if (!card.tag) throw new Error('An OPEN Quest must have a Tag');

  return { ...card, tag: card.tag };
};

const nextCursorFor = (
  rows: QuestRow[],
  hasMore: boolean,
) => {
  const last = rows[rows.length - 1];

  return hasMore && last
    ? encodeCursor({ id: last.id, startTime: last.startTime.toISOString() })
    : null;
};

export const listBoardQuests = async (filters: QuestListFilters) => {
  const result = await listRows(filters);
  const items = result.rows.map((row) => serializeBoardCard(row, result.locations));

  return {
    items,
    nextCursor: nextCursorFor(result.rows, result.hasMore),
  };
};

export const createQuest = async (
  userId: string,
  data: QuestCreateInput,
): Promise<QuestCreateOutcome> => {
  if (data.participation === questParticipation.solo && data.headcount !== 1) {
    return { outcome: 'invalid-headcount' };
  }

  const startTime = new Date(data.startTime);
  const dueAt = data.dueAt ? new Date(data.dueAt) : null;
  if (dueAt && dueAt <= startTime) return { outcome: 'invalid-dates' };

  if (data.tagId) {
    const [existingTag] = await db
      .select({ id: tag.id })
      .from(tag)
      .where(eq(tag.id, data.tagId))
      .limit(1);
    if (!existingTag) return { outcome: 'tag-not-found' };
  }

  return db.transaction(async (transaction) => {
    const [created] = await transaction
      .insert(quest)
      .values({
        hirerId: userId,
        title: data.title,
        description: data.description ?? null,
        condition: data.condition,
        mode: data.mode,
        participation: data.participation,
        questStatus: questStatus.draft,
        rewardSatang: data.reward * 100,
        tagId: data.tagId ?? null,
        headcount: data.headcount,
        startTime,
        dueAt,
        proofRequired: data.proofRequired ?? true,
      })
      .returning({ id: quest.id });

    if (data.locations && data.locations.length > 0) {
      await transaction.insert(questLocation).values(
        data.locations.map((location) => ({
          questId: created.id,
          label: location.label ?? null,
        })),
      );
    }

    return { id: created.id };
  });
};

const hasEditField = <K extends keyof QuestEditInput>(
  data: QuestEditInput,
  field: K,
): data is QuestEditInput & Required<Pick<QuestEditInput, K>> =>
  Object.prototype.hasOwnProperty.call(data, field);

const jsonValuesEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

const toEditLocation = (
  location: NonNullable<QuestEditInput['locations']>[number],
): QuestEditLocation => ({
  label: location.label ?? null,
});

const editLocationSnapshot = (locations: LocationRow[]): QuestEditLocation[] =>
  locations.map((location) => toLocation(location));

type QuestEditHistoryValue = {
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
};

type ConsentQuestRow = QuestEditRow & {
  mode: QuestMode;
  participation: QuestParticipation;
  rewardSatang: number;
  headcount: number;
};

const consentStatuses = new Set<QuestStatus>([
  questStatus.assigned,
  questStatus.inProgress,
  questStatus.submitted,
  questStatus.approved,
  questStatus.rework,
  questStatus.disputed,
]);

const consentFields = new Set([
  'title',
  'description',
  'condition',
  'startTime',
  'dueAt',
  'proofRequired',
  'locations',
  'images',
]);
const coreEditFields = new Set(['mode', 'participation', 'reward', 'headcount', 'tagId']);

const selectConsentQuest = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
): Promise<ConsentQuestRow | undefined> => {
  const [row] = await transaction
    .select({
      id: quest.id,
      title: quest.title,
      description: quest.description,
      condition: quest.condition,
      tagId: quest.tagId,
      questStatus: quest.questStatus,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
      proofRequired: quest.proofRequired,
      mode: quest.mode,
      participation: quest.participation,
      rewardSatang: quest.rewardSatang,
      headcount: quest.headcount,
    })
    .from(quest)
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.hirerId, userId),
        eq(quest.apiVersion, questApiVersion.v1),
      ),
    )
    .limit(1)
    .for('update');
  if (!row || row.rewardSatang === null) return undefined;
  return { ...row, rewardSatang: row.rewardSatang };
};

const normalizeConsentChanges = async (
  transaction: QuestTransaction,
  current: ConsentQuestRow,
  userId: string,
  data: QuestEditInput,
): Promise<
  | { outcome: 'empty-edit' | 'forbidden-fields' | 'invalid-dates' | 'invalid-files' }
  | { changes: Record<string, unknown> }
> => {
  const supplied = Object.keys(data);
  if (supplied.some((field) => coreEditFields.has(field))) return { outcome: 'forbidden-fields' };
  if (supplied.some((field) => !consentFields.has(field))) return { outcome: 'forbidden-fields' };
  if (supplied.length === 0) return { outcome: 'empty-edit' };

  const changes: Record<string, unknown> = {};
  const nextStartTime = hasEditField(data, 'startTime')
    ? new Date(data.startTime)
    : current.startTime;
  const nextDueAt = hasEditField(data, 'dueAt')
    ? data.dueAt
      ? new Date(data.dueAt)
      : null
    : current.dueAt;
  if (
    Number.isNaN(nextStartTime.getTime()) ||
    (nextDueAt !== null && Number.isNaN(nextDueAt.getTime())) ||
    (nextDueAt !== null && nextDueAt <= nextStartTime)
  ) return { outcome: 'invalid-dates' };

  if (hasEditField(data, 'title') && data.title !== current.title) changes.title = data.title;
  if (hasEditField(data, 'description') && data.description !== current.description) {
    changes.description = data.description;
  }
  if (hasEditField(data, 'condition') && data.condition !== current.condition) {
    changes.condition = data.condition;
  }
  if (hasEditField(data, 'startTime') && nextStartTime.getTime() !== current.startTime.getTime()) {
    changes.startTime = nextStartTime.toISOString();
  }
  if (hasEditField(data, 'dueAt') && (nextDueAt?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)) {
    changes.dueAt = nextDueAt?.toISOString() ?? null;
  }
  if (hasEditField(data, 'proofRequired') && data.proofRequired !== current.proofRequired) {
    changes.proofRequired = data.proofRequired;
  }
  if (hasEditField(data, 'locations')) {
    const oldLocations = editLocationSnapshot(await selectQuestLocations(transaction, current.id));
    const locations = (data.locations ?? []).map(toEditLocation);
    if (!jsonValuesEqual(oldLocations, locations)) changes.locations = locations;
  }
  if (hasEditField(data, 'images')) {
    const oldImages = (await transaction
      .select({ fileId: questImage.fileId })
      .from(questImage)
      .where(eq(questImage.questId, current.id))
      .orderBy(asc(questImage.position))).map(({ fileId }) => fileId);
    const images = data.images ?? [];
    if (!jsonValuesEqual(oldImages, images)) {
      if (!(await validateQuestImageIds(transaction, userId, images))) return { outcome: 'invalid-files' };
      changes.images = images;
    }
  }

  return Object.keys(changes).length === 0 ? { outcome: 'empty-edit' } : { changes };
};

const validateQuestImageIds = async (
  transaction: QuestTransaction,
  userId: string,
  imageIds: unknown,
) => {
  if (!Array.isArray(imageIds) || imageIds.length > maxQuestImages || imageIds.some((id) => typeof id !== 'string')) return false;
  if (imageIds.length === 0) return true;
  const ownedFiles = await transaction
    .select({ id: file.id })
    .from(file)
    .where(and(inArray(file.id, imageIds as string[]), eq(file.uploadedByUserId, userId), isNull(file.deletedAt)));
  return ownedFiles.length === imageIds.length;
};

const applyConsentChanges = async (
  transaction: QuestTransaction,
  current: ConsentQuestRow,
  changes: Record<string, unknown>,
  requestId: string,
  userId: string,
) => {
  if (Object.prototype.hasOwnProperty.call(changes, 'images') && !(await validateQuestImageIds(transaction, userId, changes.images))) {
    throw new Error('Quest edit contains an invalid image reference');
  }
  const updates: Partial<typeof quest.$inferInsert> = { updatedAt: new Date() };
  const history: QuestEditHistoryValue[] = [];
  const add = (fieldName: string, oldValue: unknown, newValue: unknown, update: keyof typeof updates) => {
    if (jsonValuesEqual(oldValue, newValue)) return;
    updates[update] = newValue as never;
    history.push({ fieldName, oldValue, newValue });
  };
  add('title', current.title, changes.title, 'title');
  add('description', current.description, changes.description, 'description');
  add('condition', current.condition, changes.condition, 'condition');
  add('startTime', current.startTime.toISOString(), changes.startTime, 'startTime');
  if (Object.prototype.hasOwnProperty.call(changes, 'startTime')) updates.startTime = new Date(changes.startTime as string);
  add('dueAt', current.dueAt?.toISOString() ?? null, changes.dueAt, 'dueAt');
  if (Object.prototype.hasOwnProperty.call(changes, 'dueAt')) updates.dueAt = changes.dueAt ? new Date(changes.dueAt as string) : null;
  add('proofRequired', current.proofRequired, changes.proofRequired, 'proofRequired');

  if (Object.prototype.hasOwnProperty.call(changes, 'locations')) {
    const oldLocations = editLocationSnapshot(await selectQuestLocations(transaction, current.id));
    const newLocations = changes.locations as QuestEditLocation[];
    if (!jsonValuesEqual(oldLocations, newLocations)) {
      await transaction.delete(questLocation).where(eq(questLocation.questId, current.id));
      if (newLocations.length > 0) {
        await transaction.insert(questLocation).values(newLocations.map((location) => ({ questId: current.id, label: location.label })));
      }
      history.push({ fieldName: 'locations', oldValue: oldLocations, newValue: newLocations });
    }
  }
  if (Object.prototype.hasOwnProperty.call(changes, 'images')) {
    const oldImages = (await transaction.select({ fileId: questImage.fileId }).from(questImage).where(eq(questImage.questId, current.id)).orderBy(asc(questImage.position))).map(({ fileId }) => fileId);
    const newImages = changes.images as string[];
    if (!jsonValuesEqual(oldImages, newImages)) {
      await transaction.delete(questImage).where(eq(questImage.questId, current.id));
      if (newImages.length > 0) await transaction.insert(questImage).values(newImages.map((fileId, position) => ({ questId: current.id, fileId, position })));
      history.push({ fieldName: 'images', oldValue: oldImages, newValue: newImages });
    }
  }
  if (history.length > 0) {
    await transaction.update(quest).set(updates).where(eq(quest.id, current.id));
    await transaction.insert(questEditHistory).values(history.map(({ fieldName, oldValue, newValue }) => ({
      questId: current.id,
      editRequestId: requestId,
      fieldName,
      oldValue,
      newValue,
      editedByUserId: userId,
    })));
  }
};

export const createQuestEditRequest = async (
  userId: string,
  questId: string,
  data: QuestEditInput,
  now = new Date(),
): Promise<QuestEditRequestOutcome> => db.transaction(async (transaction) => {
  const current = await selectConsentQuest(transaction, userId, questId);
  if (!current) return { outcome: 'not-found' };
  const existing = await transaction.select({ id: questEditRequest.id }).from(questEditRequest).where(and(eq(questEditRequest.questId, questId), eq(questEditRequest.requestStatus, 'EDIT_REQUEST_PENDING'))).limit(1);
  if (existing.length > 0) return { outcome: 'pending-request' };
  if (!consentStatuses.has(current.questStatus)) return { outcome: 'not-editable' };
  const normalized = await normalizeConsentChanges(transaction, current, userId, data);
  if ('outcome' in normalized) return normalized;
  const workers = await transaction.select({ workerId: questAssignment.workerId }).from(questAssignment).where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active))).for('update');
  if (workers.length === 0) return { outcome: 'not-editable' };
  const [request] = await transaction.insert(questEditRequest).values({
    questId,
    requestedByUserId: userId,
    proposedChanges: normalized.changes,
    previousQuestStatus: current.questStatus,
    createdAt: now,
  }).returning({ id: questEditRequest.id, createdAt: questEditRequest.createdAt });
  await transaction.insert(questEditRequestResponse).values(workers.map(({ workerId }) => ({ requestId: request.id, userId: workerId })));
  const [pausedQuest] = await transaction.update(quest).set({ questStatus: questStatus.awaitingConsent, updatedAt: new Date() }).where(and(eq(quest.id, questId), eq(quest.questStatus, current.questStatus))).returning({ id: quest.id });
  if (!pausedQuest) return { outcome: 'not-editable' };
  return { requestId: request.id, status: 'EDIT_REQUEST_PENDING', expiresAt: new Date(request.createdAt.getTime() + 5 * 60_000) };
});

export const editQuest = async (
  userId: string,
  questId: string,
  data: QuestEditInput,
): Promise<QuestEditOutcome> => {
  return db.transaction(async (transaction) => {
    const eligibility = await getQuestEditEligibility(transaction, userId, questId);
    if ('outcome' in eligibility) return eligibility;
    if (Object.keys(data).length === 0) return { outcome: 'empty-edit' };

    const current = eligibility.quest;
    if (
      Object.keys(data).some(
        (field) =>
          coreEditFields.has(field) &&
          !(current.questStatus === questStatus.draft && field === 'tagId'),
      )
    ) {
      return { outcome: 'forbidden-fields' };
    }

    const history: QuestEditHistoryValue[] = [];
    const updates: Partial<typeof quest.$inferInsert> = {};

    const nextStartTime = hasEditField(data, 'startTime')
      ? new Date(data.startTime)
      : current.startTime;
    const nextDueAt = hasEditField(data, 'dueAt')
      ? data.dueAt
        ? new Date(data.dueAt)
        : null
      : current.dueAt;

    if (
      Number.isNaN(nextStartTime.getTime()) ||
      (nextDueAt !== null && Number.isNaN(nextDueAt.getTime())) ||
      (nextDueAt !== null && nextDueAt <= nextStartTime)
    ) {
      return { outcome: 'invalid-dates' };
    }

    if (hasEditField(data, 'title') && data.title !== current.title) {
      updates.title = data.title;
      history.push({ fieldName: 'title', oldValue: current.title, newValue: data.title });
    }
    if (hasEditField(data, 'description') && data.description !== current.description) {
      updates.description = data.description;
      history.push({
        fieldName: 'description',
        oldValue: current.description,
        newValue: data.description,
      });
    }
    if (hasEditField(data, 'condition') && data.condition !== current.condition) {
      updates.condition = data.condition;
      history.push({ fieldName: 'condition', oldValue: current.condition, newValue: data.condition });
    }
    if (
      hasEditField(data, 'startTime') &&
      nextStartTime.getTime() !== current.startTime.getTime()
    ) {
      updates.startTime = nextStartTime;
      history.push({
        fieldName: 'startTime',
        oldValue: current.startTime.toISOString(),
        newValue: nextStartTime.toISOString(),
      });
    }
    if (
      hasEditField(data, 'dueAt') &&
      (nextDueAt?.getTime() ?? null) !== (current.dueAt?.getTime() ?? null)
    ) {
      updates.dueAt = nextDueAt;
      history.push({
        fieldName: 'dueAt',
        oldValue: current.dueAt?.toISOString() ?? null,
        newValue: nextDueAt?.toISOString() ?? null,
      });
    }
    if (hasEditField(data, 'tagId') && data.tagId !== current.tagId) {
      if (data.tagId === null) return { outcome: 'tag-required' };

      const [existingTag] = await transaction
        .select({ id: tag.id })
        .from(tag)
        .where(eq(tag.id, data.tagId))
        .limit(1);
      if (!existingTag) return { outcome: 'tag-not-found' };

      updates.tagId = data.tagId;
      history.push({ fieldName: 'tagId', oldValue: current.tagId, newValue: data.tagId });
    }
    if (hasEditField(data, 'proofRequired') && data.proofRequired !== current.proofRequired) {
      updates.proofRequired = data.proofRequired;
      history.push({
        fieldName: 'proofRequired',
        oldValue: current.proofRequired,
        newValue: data.proofRequired,
      });
    }

    let locationsChanged = false;
    if (hasEditField(data, 'locations')) {
      const currentLocations = await selectQuestLocations(transaction, questId);
      const oldValue = editLocationSnapshot(currentLocations);
      const newValue = (data.locations ?? []).map((location) => toEditLocation(location));

      if (!jsonValuesEqual(oldValue, newValue)) {
        await transaction.delete(questLocation).where(eq(questLocation.questId, questId));
        if (newValue.length > 0) {
          await transaction.insert(questLocation).values(
            newValue.map((location) => ({
              questId,
              label: location.label,
            })),
          );
        }

        locationsChanged = true;
        history.push({ fieldName: 'locations', oldValue, newValue });
      }
    }

    if (history.length === 0 && !locationsChanged) return { id: questId };

    updates.updatedAt = new Date();
    await transaction.update(quest).set(updates).where(eq(quest.id, questId));
    await transaction.insert(questEditHistory).values(
      history.map(({ fieldName, oldValue, newValue }) => ({
        questId,
        fieldName,
        oldValue,
        newValue,
        editedByUserId: userId,
      })),
    );

    return { id: questId };
  });
};

const consentStateIsCurrent = async (
  transaction: QuestTransaction,
  questId: string,
  previousQuestStatus: QuestStatus,
  responseRequestId: string,
): Promise<boolean> => {
  const [currentQuest] = await transaction
    .select({ questStatus: quest.questStatus })
    .from(quest)
    .where(eq(quest.id, questId))
    .limit(1);
  if (!currentQuest || currentQuest.questStatus !== questStatus.awaitingConsent || !consentStatuses.has(previousQuestStatus)) return false;
  const snapshot = await transaction
    .select({ userId: questEditRequestResponse.userId })
    .from(questEditRequestResponse)
    .where(eq(questEditRequestResponse.requestId, responseRequestId));
  const active = await transaction
    .select({ workerId: questAssignment.workerId })
    .from(questAssignment)
    .where(and(eq(questAssignment.questId, questId), eq(questAssignment.assignmentStatus, assignmentStatus.active)));
  const expected = snapshot.map(({ userId }) => userId).sort();
  const actual = active.map(({ workerId }) => workerId).sort();
  return expected.length === actual.length && expected.every((workerId, index) => workerId === actual[index]);
};

const resolveExpiredEditRequestInTransaction = async (
  transaction: QuestTransaction,
  requestId: string,
  now: Date,
): Promise<QuestEditResponseOutcome> => {
  const [request] = await transaction.select({
    id: questEditRequest.id,
    questId: questEditRequest.questId,
    requestedByUserId: questEditRequest.requestedByUserId,
    previousQuestStatus: questEditRequest.previousQuestStatus,
    requestStatus: questEditRequest.requestStatus,
    createdAt: questEditRequest.createdAt,
  }).from(questEditRequest).where(eq(questEditRequest.id, requestId)).limit(1);
  if (!request) return { outcome: 'not-found' };
  const current = await selectConsentQuest(transaction, request.requestedByUserId, request.questId);
  if (!current) return { outcome: 'not-found' };
  const [lockedRequest] = await transaction.select({
    id: questEditRequest.id,
    requestStatus: questEditRequest.requestStatus,
  }).from(questEditRequest).where(eq(questEditRequest.id, requestId)).limit(1).for('update');
  if (!lockedRequest || lockedRequest.requestStatus !== 'EDIT_REQUEST_PENDING') {
    return { outcome: 'not-pending' };
  }
  if (!(await consentStateIsCurrent(transaction, request.questId, request.previousQuestStatus, requestId))) {
    await transaction.update(questEditRequest).set({ requestStatus: 'EDIT_REQUEST_REJECTED', resolvedAt: now }).where(eq(questEditRequest.id, requestId));
    if (current.questStatus === questStatus.awaitingConsent) await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
    return { outcome: 'not-pending' };
  }
  if (now.getTime() < request.createdAt.getTime() + 5 * 60_000) {
    return { status: 'EDIT_REQUEST_PENDING', requestId };
  }
  await transaction.update(questEditRequest).set({
    requestStatus: 'EDIT_REQUEST_REJECTED',
    resolvedAt: now,
  }).where(eq(questEditRequest.id, requestId));
  await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
  return { status: 'EDIT_REQUEST_REJECTED', requestId };
};

export const respondToQuestEditRequest = async (
  userId: string,
  requestId: string,
  decision: 'EDIT_RESPONSE_APPROVED' | 'EDIT_RESPONSE_REJECTED',
  now = new Date(),
): Promise<QuestEditResponseOutcome> => db.transaction(async (transaction) => {
  const [request] = await transaction.select({
    id: questEditRequest.id,
    questId: questEditRequest.questId,
    requestedByUserId: questEditRequest.requestedByUserId,
    previousQuestStatus: questEditRequest.previousQuestStatus,
    requestStatus: questEditRequest.requestStatus,
    proposedChanges: questEditRequest.proposedChanges,
    createdAt: questEditRequest.createdAt,
  }).from(questEditRequest).where(eq(questEditRequest.id, requestId)).limit(1);
  if (!request) return { outcome: 'not-found' };
  const current = await selectConsentQuest(transaction, request.requestedByUserId, request.questId);
  if (!current) return { outcome: 'not-found' };
  const [lockedRequest] = await transaction.select({
    id: questEditRequest.id,
    requestStatus: questEditRequest.requestStatus,
  }).from(questEditRequest).where(eq(questEditRequest.id, requestId)).limit(1).for('update');
  if (!lockedRequest || lockedRequest.requestStatus !== 'EDIT_REQUEST_PENDING') return { outcome: 'not-pending' };
  if (!(await consentStateIsCurrent(transaction, request.questId, request.previousQuestStatus, requestId))) {
    await transaction.update(questEditRequest).set({ requestStatus: 'EDIT_REQUEST_REJECTED', resolvedAt: now }).where(eq(questEditRequest.id, requestId));
    if (current.questStatus === questStatus.awaitingConsent) await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
    return { outcome: 'not-pending' };
  }
  if (now.getTime() >= request.createdAt.getTime() + 5 * 60_000) {
    await transaction.update(questEditRequest).set({ requestStatus: 'EDIT_REQUEST_REJECTED', resolvedAt: now }).where(eq(questEditRequest.id, requestId));
    await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
    return { outcome: 'expired' };
  }
  const [response] = await transaction.select({ id: questEditRequestResponse.id, decision: questEditRequestResponse.decision }).from(questEditRequestResponse).where(and(eq(questEditRequestResponse.requestId, requestId), eq(questEditRequestResponse.userId, userId))).limit(1).for('update');
  if (!response) return { outcome: 'not-authorized' };
  if (response.decision !== null) return { outcome: 'already-responded' };
  await transaction.update(questEditRequestResponse).set({ decision, respondedAt: now }).where(eq(questEditRequestResponse.id, response.id));
  if (decision === 'EDIT_RESPONSE_REJECTED') {
    await transaction.update(questEditRequest).set({ requestStatus: 'EDIT_REQUEST_REJECTED', resolvedAt: now }).where(eq(questEditRequest.id, requestId));
    await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
    return { status: 'EDIT_REQUEST_REJECTED', requestId };
  }
  const responses = await transaction.select({ decision: questEditRequestResponse.decision }).from(questEditRequestResponse).where(eq(questEditRequestResponse.requestId, requestId));
  if (responses.some(({ decision: value }) => value !== 'EDIT_RESPONSE_APPROVED')) return { status: 'EDIT_REQUEST_PENDING', requestId };
  if (!(await consentStateIsCurrent(transaction, request.questId, request.previousQuestStatus, requestId))) {
    await transaction.update(questEditRequest).set({ requestStatus: 'EDIT_REQUEST_REJECTED', resolvedAt: now }).where(eq(questEditRequest.id, requestId));
    await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
    return { outcome: 'not-pending' };
  }
  const proposedChanges = request.proposedChanges as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(proposedChanges, 'images') && !(await validateQuestImageIds(transaction, request.requestedByUserId, proposedChanges.images))) {
    await transaction.update(questEditRequest).set({ requestStatus: 'EDIT_REQUEST_REJECTED', resolvedAt: now }).where(eq(questEditRequest.id, requestId));
    await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
    return { outcome: 'invalid-files' };
  }
  await applyConsentChanges(transaction, current, proposedChanges, requestId, request.requestedByUserId);
  await transaction.update(questEditRequest).set({ requestStatus: 'EDIT_REQUEST_APPROVED', resolvedAt: now }).where(eq(questEditRequest.id, requestId));
  await transaction.update(quest).set({ questStatus: request.previousQuestStatus, updatedAt: now }).where(eq(quest.id, request.questId));
  return { status: 'EDIT_REQUEST_APPROVED', requestId };
});

export const expireQuestEditRequest = async (
  requestId: string,
  now = new Date(),
): Promise<QuestEditResponseOutcome> => db.transaction(async (transaction) => resolveExpiredEditRequestInTransaction(transaction, requestId, now));

/** Worker entry point for BE-182. It is explicit and deterministic; no scheduler lives here. */
export const timeoutQuestEditRequest = expireQuestEditRequest;

export const expireQuestEditRequests = async (now = new Date()): Promise<string[]> => {
  const pending = await db.select({ id: questEditRequest.id }).from(questEditRequest).where(eq(questEditRequest.requestStatus, 'EDIT_REQUEST_PENDING'));
  const resolved: string[] = [];
  for (const request of pending) {
    const outcome = await expireQuestEditRequest(request.id, now);
    if ('status' in outcome && outcome.status === 'EDIT_REQUEST_REJECTED') resolved.push(request.id);
  }
  return resolved;
};

export const expirePendingQuestEditRequests = expireQuestEditRequests;

export const getQuestEditRequest = async (userId: string, requestId: string) => {
  const [row] = await db.select({
    id: questEditRequest.id,
    questId: questEditRequest.questId,
    requestedByUserId: questEditRequest.requestedByUserId,
    previousQuestStatus: questEditRequest.previousQuestStatus,
    status: questEditRequest.requestStatus,
    proposedChanges: questEditRequest.proposedChanges,
    createdAt: questEditRequest.createdAt,
  }).from(questEditRequest).innerJoin(quest, eq(questEditRequest.questId, quest.id)).where(and(eq(questEditRequest.id, requestId), or(eq(quest.hirerId, userId), sql`EXISTS (SELECT 1 FROM quest_edit_request_response r WHERE r.request_id = ${questEditRequest.id} AND r.user_id = ${userId})`))).limit(1);
  if (!row) return undefined;
  const responses = await db.select({ userId: questEditRequestResponse.userId, decision: questEditRequestResponse.decision, respondedAt: questEditRequestResponse.respondedAt }).from(questEditRequestResponse).where(eq(questEditRequestResponse.requestId, requestId));
  return { ...row, expiresAt: new Date(row.createdAt.getTime() + 5 * 60_000), responses };
};

export const addQuestImages = async (
  userId: string,
  questId: string,
  images: StoredQuestImage[],
): Promise<AddQuestImagesOutcome> =>
  db.transaction(async (transaction) => {
    const uploadCheck = await checkQuestImageUploadInTransaction(
      transaction,
      userId,
      questId,
      images.length,
    );
    if ('outcome' in uploadCheck) return uploadCheck;

    for (const [index, image] of images.entries()) {
      const [createdFile] = await transaction
        .insert(file)
        .values({ ...image, uploadedByUserId: userId })
        .returning({ id: file.id });

      await transaction.insert(questImage).values({
        questId,
        fileId: createdFile.id,
        position: uploadCheck.currentCount + index,
      });
    }

    return { images: await selectQuestImages(transaction, questId) };
  });

export const checkQuestImageUpload = async (
  userId: string,
  questId: string,
  imageCountToAdd: number,
): Promise<QuestImageMutationOutcome | undefined> =>
  db.transaction(async (transaction) => {
    const result = await checkQuestImageUploadInTransaction(
      transaction,
      userId,
      questId,
      imageCountToAdd,
    );

    return 'outcome' in result ? result : undefined;
  });

export type DeleteQuestImageOutcome =
  | { outcome: 'deleted'; bucket: string; objectKey: string }
  | { outcome: 'not-found' | 'not-editable' };

export const deleteQuestImage = async (
  userId: string,
  questId: string,
  fileId: string,
): Promise<DeleteQuestImageOutcome> =>
  db.transaction(async (transaction) => {
    const ownedQuest = await lockOwnedQuest(transaction, userId, questId);

    if (!ownedQuest) return { outcome: 'not-found' };
    if (ownedQuest.questStatus !== questStatus.draft) return { outcome: 'not-editable' };

    const [image] = await transaction
      .select({
        id: questImage.id,
        fileId: file.id,
        bucket: file.bucket,
        objectKey: file.objectKey,
      })
      .from(questImage)
      .innerJoin(file, and(eq(questImage.fileId, file.id), isNull(file.deletedAt)))
      .where(and(eq(questImage.questId, questId), eq(questImage.fileId, fileId)))
      .limit(1)
      .for('update');

    if (!image) return { outcome: 'not-found' };

    await softDeleteQuestImageAndRepack(transaction, {
      questId,
      questImageId: image.id,
      fileId: image.fileId,
      deletedAt: new Date(),
      positionOffset: maxQuestImages,
    });

    return { outcome: 'deleted', bucket: image.bucket, objectKey: image.objectKey };
  });

export const listOwnQuests = async (userId: string, filters: QuestListFilters) => {
  const result = await listRows(filters, userId);
  const items = result.rows.map((row) => ({
    ...serializeCard(row, result.locations),
    questStatus: row.questStatus,
  }));

  return {
    items,
    nextCursor: nextCursorFor(result.rows, result.hasMore),
  };
};

export const getQuestDetail = async (userId: string, questId: string) => {
  const [row] = await db
    .select({
      id: quest.id,
      title: quest.title,
      description: quest.description,
      condition: quest.condition,
      rewardSatang: quest.rewardSatang,
      tagId: tag.id,
      tagName: tag.name,
      mode: quest.mode,
      participation: quest.participation,
      questStatus: quest.questStatus,
      headcount: quest.headcount,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
      proofRequired: quest.proofRequired,
      hirerFirstName: authUser.firstName,
      hirerLastName: authUser.lastName,
    })
    .from(quest)
    .innerJoin(authUser, eq(quest.hirerId, authUser.id))
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.apiVersion, questApiVersion.v1),
        or(
          eq(quest.hirerId, userId),
          eq(quest.questStatus, questStatus.open),
          exists(sql`(
            select 1
            from quest_assignment a
            where a.quest_id = ${quest.id}
              and a.worker_id = ${userId}
              and a.assignment_status = ${assignmentStatus.active}
          )`),
        ),
      ),
    )
    .limit(1);

  if (!row) return undefined;

  const locations = await selectQuestLocations(db, questId);

  const images = await selectQuestImages(db, questId);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    condition: row.condition,
    reward: toRewardBaht(requireQuestReward(row.rewardSatang)),
    tag: row.tagId && row.tagName ? { id: row.tagId, name: row.tagName } : null,
    mode: row.mode,
    participation: row.participation,
    questStatus: row.questStatus,
    headcount: row.headcount,
    startTime: row.startTime.toISOString(),
    dueAt: row.dueAt?.toISOString() ?? null,
    estimatedDurationMinutes: durationMinutes(row.startTime, row.dueAt),
    proofRequired: row.proofRequired,
    hirerName: hirerName(row),
    locations: locations.map((location) => toLocation(location)),
    images,
  };
};

const selectPublishRow = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  lock: boolean,
): Promise<QuestPublishRow | undefined> => {
  const query = transaction
    .select({
      id: quest.id,
      questStatus: quest.questStatus,
      tagId: quest.tagId,
      rewardSatang: quest.rewardSatang,
      headcount: quest.headcount,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
    })
    .from(quest)
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.hirerId, userId),
        eq(quest.apiVersion, questApiVersion.v1),
      ),
    )
    .limit(1);

  const rows = lock ? await query.for('update') : await query;
  const row = rows[0];
  if (!row || row.rewardSatang === null) return undefined;
  return { ...row, rewardSatang: row.rewardSatang };
};

const buildPublishSnapshot = async (
  transaction: QuestTransaction,
  row: QuestPublishRow,
): Promise<QuestPublishSnapshot> => {
  const [imageRows] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questImage)
    .where(eq(questImage.questId, row.id));
  const [locationRows] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questLocation)
    .where(eq(questLocation.questId, row.id));
  const policy = await getEffectiveFundingReservationPolicy(transaction);

  return {
    tagId: row.tagId,
    startTime: row.startTime,
    dueAt: row.dueAt,
    hasImages: Number(imageRows?.count ?? 0) > 0,
    hasLocations: Number(locationRows?.count ?? 0) > 0,
    rewardSatang: row.rewardSatang,
    headcount: row.headcount,
    platformFeeBps: policy.platformFeeBps,
    policyRevisionId: policy.id,
    policyRevision: policy.revision,
    now: new Date(),
  };
};

const buildPublishCheck = async (
  transaction: QuestTransaction,
  row: QuestPublishRow,
) => buildQuestPublishCheck(await buildPublishSnapshot(transaction, row));

export const getQuestPublishCheck = async (
  userId: string,
  questId: string,
): Promise<QuestPublishCheck | { outcome: 'not-draft' } | undefined> =>
  db.transaction(async (transaction) => {
    const row = await selectPublishRow(transaction, userId, questId, false);
    if (!row) return undefined;
    if (row.questStatus !== questStatus.draft) return { outcome: 'not-draft' };

    return buildPublishCheck(transaction, row);
  });

export const publishQuest = async (
  userId: string,
  questId: string,
): Promise<QuestPublishOutcome | undefined> =>
  db.transaction(async (transaction) => {
    const row = await selectPublishRow(transaction, userId, questId, true);
    if (!row) return undefined;
    if (row.questStatus !== questStatus.draft) return { outcome: 'not-draft' };

    const snapshot = await buildPublishSnapshot(transaction, row);
    const check = buildQuestPublishCheck(snapshot);
    if (!check.canPublish) return { outcome: 'blocked', check };

    const reservation = await reserveSpending(transaction, {
      ownerUserId: userId,
      callerScope: 'quest',
      callerReference: questId,
      amountSatang: calculateQuestEscrowRequirementSatang(snapshot),
    });

    const [updated] = await transaction
      .update(quest)
      .set({
        questStatus: questStatus.open,
        fundingReservationId: reservation.id,
        policyRevisionId: snapshot.policyRevisionId,
        platformFeeBps: snapshot.platformFeeBps,
        platformFeePerWorkerSatang: Number(check.platformFeePerWorkerSatang),
        questEscrowSatang: Number(check.escrowRequirementSatang),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(quest.id, questId),
          eq(quest.hirerId, userId),
          eq(quest.questStatus, questStatus.draft),
        ),
      )
      .returning({ id: quest.id });

    return updated
      ? {
          outcome: 'published',
          reservationId: reservation.id,
          policyRevisionId: snapshot.policyRevisionId!,
          policyRevision: snapshot.policyRevision!,
          platformFeeBps: snapshot.platformFeeBps,
          platformFeePerWorkerSatang: Number(check.platformFeePerWorkerSatang),
          questEscrowSatang: Number(check.escrowRequirementSatang),
        }
      : { outcome: 'not-draft' };
  });
