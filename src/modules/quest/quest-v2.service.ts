import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questConditionItem,
  questImage,
  questLocation,
} from '@/database/schema/quest.schema';
import { file } from '@/database/schema/file.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey, walletWallet } from '@/database/schema/wallet.schema';
import {
  getEffectiveFundingReservationPolicy,
  MoneyDomainError,
  positiveSatang,
  satang,
  toBaht,
  type Satang,
} from '@/modules/wallet';
import { decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import { and, asc, eq, gt, isNull, like, lte, or, sql } from 'drizzle-orm';

import { questStatus, type QuestStatus } from './quest.contract';
import { questV2StorageCompatibility } from './quest-storage.adapter';
import {
  questV2Participation,
  questV2States,
  type QuestV2CanonicalQuest,
  type QuestV2Mode,
  type QuestV2Participation,
  type QuestV2State,
} from './quest-v2.contract';
import {
  buildQuestV2PublishCheck,
  type QuestV2PublishCheck,
} from './quest-v2.publish.policy';
import { softDeleteQuestImageAndRepack } from './quest-image.persistence';
import { maxQuestV2Images } from './quest-v2.schema';
import type { QuestV2CreateInput, QuestV2EditInput } from './quest-v2.schema';
import { questV2Storage, type StoredQuestImage } from './quest.storage';

type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuestDatabase = typeof db | QuestTransaction;

export const questV2CreateOperationScope = 'quest.v2.create';
export const questV2EditOperationScope = 'quest.v2.edit';
export const questV2ImageUploadOperationScope = 'quest.v2.image.upload';
export const questV2ImageRemoveOperationScope = 'quest.v2.image.remove';
const questV2CreatePath = '/api/v2/quests';
const questV2EditPath = '/api/v2/quests/:questId';
const questV2ImageUploadPath = '/api/v2/quests/:questId/images';
const questV2ImageRemovePath = '/api/v2/quests/:questId/images/:imageId';

const explicitTimezonePattern = /(?:Z|[+-]\d{2}:\d{2})$/;

type NormalizedCreateInput = {
  title: string;
  description: string | null;
  conditionItems: string[];
  mode: QuestV2Mode;
  participation: QuestV2Participation;
  questFundingTotalSatang: Satang;
  headcount: number;
  startTime: Date;
  dueAt: Date | null;
  tagId: string | null;
  proofRequired: boolean;
  locations: Array<{ label: string }>;
};

type NormalizedEditInput = {
  title?: string;
  description?: string | null;
  conditionItems?: string[];
  mode?: QuestV2Mode;
  participation?: QuestV2Participation;
  questFundingTotalSatang?: Satang;
  headcount?: number;
  startTime?: Date;
  dueAt?: Date | null;
  tagId?: string | null;
  proofRequired?: boolean;
  locations?: Array<{ label: string }>;
};

type QuestV2CreateValidationOutcome =
  | 'invalid-condition'
  | 'invalid-dates'
  | 'invalid-description'
  | 'invalid-funding'
  | 'invalid-headcount'
  | 'invalid-idempotency-key'
  | 'invalid-location'
  | 'invalid-title'
  | 'tag-not-found'
  | 'idempotency-unavailable';

type QuestV2EditValidationOutcome =
  | 'empty-edit'
  | 'invalid-condition'
  | 'invalid-dates'
  | 'invalid-description'
  | 'invalid-funding'
  | 'invalid-headcount'
  | 'invalid-idempotency-key'
  | 'invalid-location'
  | 'invalid-title'
  | 'invalid-version';

type QuestV2EditOutcomeCode =
  | QuestV2EditValidationOutcome
  | 'not-found'
  | 'not-draft'
  | 'conflict'
  | 'tag-not-found'
  | 'idempotency-key-reused'
  | 'idempotency-in-progress'
  | 'idempotency-unavailable';

export type QuestV2CreateOutcome =
  | { quest: QuestV2CanonicalQuest }
  | {
      outcome:
        | QuestV2CreateValidationOutcome
        | 'idempotency-key-reused'
        | 'idempotency-in-progress';
    };

export type QuestV2EditOutcome =
  | { quest: QuestV2CanonicalQuest }
  | { outcome: QuestV2EditOutcomeCode };

export type QuestV2PublishCheckOutcome =
  | QuestV2PublishCheck
  | { outcome: 'not-draft' };

export type QuestV2ImageReference = {
  imageId: string;
  fileId: string;
  position: number;
  bucket: string;
  objectKey: string;
};

export type QuestV2ImageResponse = {
  imageId: string;
  fileId: string;
  position: number;
  url: string;
  urlExpiresAt: string;
};

export type QuestV2ImageCommandContext = {
  userId: string;
  questId: string;
  key: string;
  requestHash: string;
};

export type QuestV2Detail = QuestV2CanonicalQuest & {
  images: QuestV2ImageReference[];
};

type QuestV2ImageMutationOutcome =
  | 'invalid-idempotency-key'
  | 'not-found'
  | 'not-draft'
  | 'limit-reached'
  | 'idempotency-key-reused'
  | 'idempotency-in-progress'
  | 'idempotency-unavailable';

export type QuestV2ImageUploadPreflight =
  | { canUpload: true }
  | { replay: { images: QuestV2ImageResponse[] } }
  | { outcome: QuestV2ImageMutationOutcome };

export type QuestV2ImageUploadOutcome =
  | {
      images: QuestV2ImageReference[];
      response: QuestV2ImageResponse[];
      replayed?: boolean;
    }
  | { outcome: QuestV2ImageMutationOutcome };

export type QuestV2ImageRemoveOutcome =
  | { images: QuestV2ImageReference[]; response: QuestV2ImageResponse[] }
  | { outcome: QuestV2ImageMutationOutcome };

type QuestV2Row = {
  id: string;
  version: number;
  title: string;
  description: string | null;
  v2Mode: QuestV2Mode | null;
  v2Participation: QuestV2Participation | null;
  questStatus: QuestStatus;
  questFundingTotalSatang: number | null;
  headcount: number;
  startTime: Date;
  dueAt: Date | null;
  proofRequired: boolean;
  tagId: string | null;
  tagName: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const questV2RowSelection = {
  id: quest.id,
  version: quest.version,
  title: quest.title,
  description: quest.description,
  v2Mode: quest.v2Mode,
  v2Participation: quest.v2Participation,
  questStatus: quest.questStatus,
  questFundingTotalSatang: quest.questFundingTotalSatang,
  headcount: quest.headcount,
  startTime: quest.startTime,
  dueAt: quest.dueAt,
  proofRequired: quest.proofRequired,
  tagId: tag.id,
  tagName: tag.name,
  createdAt: quest.createdAt,
  updatedAt: quest.updatedAt,
};

class QuestV2InputError extends Error {
  constructor(readonly outcome: QuestV2CreateValidationOutcome) {
    super(outcome);
    this.name = 'QuestV2InputError';
  }
}

class QuestV2EditError extends Error {
  constructor(readonly outcome: QuestV2EditOutcomeCode) {
    super(outcome);
    this.name = 'QuestV2EditError';
  }
}

const idempotencyExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const sha256Json = async (value: object): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(value)),
  );

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const parseQuestFundingTotalSatang = (value: number): Satang | undefined => {
  if (!Number.isFinite(value) || value < 1 || value > 700000) return undefined;

  const [bahtPart, satangPart] = value.toString().split('.');
  if (
    !bahtPart ||
    !/^\d+$/.test(bahtPart) ||
    (satangPart !== undefined && !/^\d{1,2}$/.test(satangPart))
  ) {
    return undefined;
  }

  // Parse the decimal representation as an integer string. Do not multiply a
  // floating-point Baht value during the conversion.
  const valueInSatang = Number(`${bahtPart}${(satangPart ?? '').padEnd(2, '0')}`);
  if (!Number.isSafeInteger(valueInSatang) || valueInSatang < 100 || valueInSatang > 70000000) {
    return undefined;
  }

  try {
    return positiveSatang(valueInSatang);
  } catch {
    return undefined;
  }
};

const normalizeCreateInput = (
  data: QuestV2CreateInput,
): NormalizedCreateInput | { outcome: Exclude<QuestV2CreateValidationOutcome, 'tag-not-found' | 'idempotency-unavailable'> } => {
  const conditionItems = data.condition.items.map((item) => item.trim());
  if (
    conditionItems.length === 0 ||
    conditionItems.some((item) => item.length === 0 || item.length > 255)
  ) {
    return { outcome: 'invalid-condition' };
  }

  const startTime = new Date(data.startTime);
  const dueAt = data.dueAt === undefined || data.dueAt === null ? null : new Date(data.dueAt);
  if (
    !explicitTimezonePattern.test(data.startTime) ||
    (typeof data.dueAt === 'string' && !explicitTimezonePattern.test(data.dueAt)) ||
    Number.isNaN(startTime.getTime()) ||
    (dueAt !== null && Number.isNaN(dueAt.getTime())) ||
    (dueAt !== null && dueAt <= startTime)
  ) {
    return { outcome: 'invalid-dates' };
  }

  const questFundingTotalSatang = parseQuestFundingTotalSatang(data.questFundingTotal);
  if (!questFundingTotalSatang) {
    return { outcome: 'invalid-funding' };
  }

  if (
    !Number.isInteger(data.headcount) ||
    data.headcount < 1 ||
    data.headcount > 20 ||
    (data.participation === questV2Participation.single && data.headcount !== 1)
  ) {
    return { outcome: 'invalid-headcount' };
  }

  const title = data.title.trim();
  if (title.length === 0 || title.length > 120) return { outcome: 'invalid-title' };

  const description =
    data.description === undefined || data.description === null ? null : data.description.trim();
  if (description !== null && (description.length === 0 || description.length > 1000)) {
    return { outcome: 'invalid-description' };
  }
  const normalizedLocations = (data.locations ?? []).map((location) => ({
    label:
      location && typeof location.label === 'string' ? location.label.trim() : null,
  }));
  const locations = normalizedLocations.filter(
    (location): location is { label: string } =>
      location.label !== null && location.label.length > 0 && location.label.length <= 100,
  );
  if (locations.length > 10 || locations.length !== normalizedLocations.length) {
    return { outcome: 'invalid-location' };
  }

  return {
    title,
    description,
    conditionItems,
    mode: data.mode,
    participation: data.participation,
    questFundingTotalSatang,
    headcount: data.headcount,
    startTime,
    dueAt,
    tagId: data.tagId ?? null,
    proofRequired: data.proofRequired ?? true,
    locations,
  };
};

const hasEditField = <K extends keyof QuestV2EditInput>(
  data: QuestV2EditInput,
  field: K,
): data is QuestV2EditInput & Required<Pick<QuestV2EditInput, K>> =>
  Object.prototype.hasOwnProperty.call(data, field);

const normalizeEditInput = (
  data: QuestV2EditInput,
): NormalizedEditInput | { outcome: QuestV2EditValidationOutcome } => {
  if (Object.keys(data).length === 0) return { outcome: 'empty-edit' };

  const normalized: NormalizedEditInput = {};

  if (hasEditField(data, 'title')) {
    if (typeof data.title !== 'string') return { outcome: 'invalid-title' };
    const title = data.title.trim();
    if (title.length === 0 || title.length > 120) return { outcome: 'invalid-title' };
    normalized.title = title;
  }

  if (hasEditField(data, 'description')) {
    if (data.description === null) {
      normalized.description = null;
    } else {
      if (typeof data.description !== 'string') return { outcome: 'invalid-description' };
      const description = data.description.trim();
      if (description.length === 0 || description.length > 1000) {
        return { outcome: 'invalid-description' };
      }
      normalized.description = description;
    }
  }

  if (hasEditField(data, 'condition')) {
    if (!data.condition || !Array.isArray(data.condition.items)) {
      return { outcome: 'invalid-condition' };
    }
    const conditionItems = data.condition.items.map((item) =>
      typeof item === 'string' ? item.trim() : '',
    );
    if (
      conditionItems.length === 0 ||
      conditionItems.some((item) => item.length === 0 || item.length > 255)
    ) {
      return { outcome: 'invalid-condition' };
    }
    normalized.conditionItems = conditionItems;
  }

  if (hasEditField(data, 'questFundingTotal')) {
    if (typeof data.questFundingTotal !== 'number') return { outcome: 'invalid-funding' };
    const questFundingTotalSatang = parseQuestFundingTotalSatang(data.questFundingTotal);
    if (!questFundingTotalSatang) return { outcome: 'invalid-funding' };
    normalized.questFundingTotalSatang = questFundingTotalSatang;
  }

  if (hasEditField(data, 'headcount')) {
    if (!Number.isInteger(data.headcount) || data.headcount < 1 || data.headcount > 20) {
      return { outcome: 'invalid-headcount' };
    }
    normalized.headcount = data.headcount;
  }

  if (hasEditField(data, 'startTime')) {
    if (typeof data.startTime !== 'string' || !explicitTimezonePattern.test(data.startTime)) {
      return { outcome: 'invalid-dates' };
    }
    const startTime = new Date(data.startTime);
    if (Number.isNaN(startTime.getTime())) return { outcome: 'invalid-dates' };
    normalized.startTime = startTime;
  }

  if (hasEditField(data, 'dueAt')) {
    if (data.dueAt === null) {
      normalized.dueAt = null;
    } else {
      if (typeof data.dueAt !== 'string' || !explicitTimezonePattern.test(data.dueAt)) {
        return { outcome: 'invalid-dates' };
      }
      const dueAt = new Date(data.dueAt);
      if (Number.isNaN(dueAt.getTime())) return { outcome: 'invalid-dates' };
      normalized.dueAt = dueAt;
    }
  }

  if (hasEditField(data, 'tagId')) normalized.tagId = data.tagId;
  if (hasEditField(data, 'mode')) normalized.mode = data.mode;
  if (hasEditField(data, 'participation')) normalized.participation = data.participation;
  if (hasEditField(data, 'proofRequired')) normalized.proofRequired = data.proofRequired;

  if (hasEditField(data, 'locations')) {
    if (!Array.isArray(data.locations)) return { outcome: 'invalid-location' };
    const locations = data.locations.map((location) => {
      if (!location || typeof location.label !== 'string') return null;
      const label = location.label.trim();
      return label.length > 0 && label.length <= 100 ? { label } : null;
    });
    if (locations.some((location) => location === null)) return { outcome: 'invalid-location' };
    normalized.locations = locations as Array<{ label: string }>;
  }

  return normalized;
};

const requestHashFor = (userId: string, input: NormalizedCreateInput): Promise<string> =>
  sha256Json({
    authenticatedMemberId: userId,
    operation: questV2CreateOperationScope,
    path: questV2CreatePath,
    questId: null,
    body: {
      title: input.title,
      description: input.description,
      condition: { items: input.conditionItems },
      mode: input.mode,
      participation: input.participation,
      questFundingTotalSatang: input.questFundingTotalSatang,
      headcount: input.headcount,
      startTime: input.startTime.toISOString(),
      dueAt: input.dueAt?.toISOString() ?? null,
      tagId: input.tagId,
      proofRequired: input.proofRequired,
      locations: input.locations,
    },
  });

const editRequestHashFor = (
  userId: string,
  questId: string,
  expectedVersion: number,
  input: NormalizedEditInput,
): Promise<string> =>
  sha256Json({
    authenticatedMemberId: userId,
    operation: questV2EditOperationScope,
    path: questV2EditPath,
    questId,
    expectedVersion,
    body: input,
  });

const selectQuestV2Row = async (
  database: QuestDatabase,
  userId: string,
  questId: string,
): Promise<QuestV2Row | undefined> => {
  const [row] = await database
    .select(questV2RowSelection)
    .from(quest)
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.hirerId, userId),
        eq(quest.apiVersion, questApiVersion.v2),
      ),
    )
    .limit(1);

  return row as QuestV2Row | undefined;
};

const selectConditionItems = async (database: QuestDatabase, questId: string) =>
  database
    .select({ position: questConditionItem.position, text: questConditionItem.text })
    .from(questConditionItem)
    .where(eq(questConditionItem.questId, questId))
    .orderBy(asc(questConditionItem.position));

const selectLocations = async (database: QuestDatabase, questId: string) => {
  const locations = await database
    .select({ label: questLocation.label })
    .from(questLocation)
    .where(eq(questLocation.questId, questId))
    .orderBy(asc(questLocation.id));

  return locations.map((location) => {
    const label = location.label?.trim();
    if (!label || label.length > 100) {
      throw new Error(`Quest ${questId} has an invalid location label`);
    }
    return { label };
  });
};

const toV2State = (status: QuestStatus): QuestV2State => {
  if (!questV2States.includes(status as QuestV2State)) {
    throw new Error(`Unsupported Quest State for v2: ${status}`);
  }

  return status as QuestV2State;
};

const buildCanonicalQuest = async (
  database: QuestDatabase,
  row: QuestV2Row,
): Promise<QuestV2CanonicalQuest> => {
  if (!row.v2Mode || !row.v2Participation || row.questFundingTotalSatang === null) {
    throw new Error(`Quest ${row.id} has incomplete v2 persistence data`);
  }
  const questFundingTotalSatang = satang(row.questFundingTotalSatang);

  const [conditionItems, locations] = await Promise.all([
    selectConditionItems(database, row.id),
    selectLocations(database, row.id),
  ]);
  if (conditionItems.length === 0) {
    throw new Error(`Quest ${row.id} has no Condition Items`);
  }

  return {
    id: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    condition: { items: conditionItems },
    tag: row.tagId && row.tagName ? { id: row.tagId, name: row.tagName } : null,
    mode: row.v2Mode,
    participation: row.v2Participation,
    state: toV2State(row.questStatus),
    questFundingTotal: toBaht(questFundingTotalSatang),
    headcount: row.headcount,
    startTime: row.startTime.toISOString(),
    dueAt: row.dueAt?.toISOString() ?? null,
    proofRequired: row.proofRequired,
    locations,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

const selectQuestV2Images = async (
  database: QuestDatabase,
  questId: string,
): Promise<QuestV2ImageReference[]> =>
  database
    .select({
      imageId: questImage.id,
      fileId: questImage.fileId,
      position: questImage.position,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(questImage)
    .innerJoin(file, and(eq(questImage.fileId, file.id), isNull(file.deletedAt)))
    .where(eq(questImage.questId, questId))
    .orderBy(asc(questImage.position), asc(questImage.id));

type QuestV2ImageIdempotencySnapshot = {
  images: QuestV2ImageReference[];
  response: QuestV2ImageResponse[];
};

const toQuestV2ImageIdempotencySnapshot = (
  images: QuestV2ImageReference[],
  response: QuestV2ImageResponse[],
): QuestV2ImageIdempotencySnapshot => ({ images, response });

const isQuestV2ImageReference = (value: unknown): value is QuestV2ImageReference => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const image = value as Partial<QuestV2ImageReference>;
  return (
    typeof image.imageId === 'string' &&
    typeof image.fileId === 'string' &&
    typeof image.position === 'number' &&
    Number.isInteger(image.position) &&
    image.position >= 0 &&
    typeof image.bucket === 'string' &&
    typeof image.objectKey === 'string'
  );
};

const isQuestV2ImageResponse = (value: unknown): value is QuestV2ImageResponse => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const image = value as Partial<QuestV2ImageResponse>;
  return (
    typeof image.imageId === 'string' &&
    typeof image.fileId === 'string' &&
    typeof image.position === 'number' &&
    Number.isInteger(image.position) &&
    image.position >= 0 &&
    typeof image.url === 'string' &&
    typeof image.urlExpiresAt === 'string'
  );
};

const fromQuestV2ImageIdempotencySnapshot = (
  resultData: unknown,
): QuestV2ImageIdempotencySnapshot | undefined => {
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) {
    return undefined;
  }

  const snapshot = resultData as Partial<QuestV2ImageIdempotencySnapshot>;
  if (
    !Array.isArray(snapshot.images) ||
    snapshot.images.some((image) => !isQuestV2ImageReference(image)) ||
    !Array.isArray(snapshot.response) ||
    snapshot.response.some((image) => !isQuestV2ImageResponse(image))
  ) {
    return undefined;
  }

  return { images: snapshot.images, response: snapshot.response };
};

const materializeQuestV2ImageResponse = (
  images: QuestV2ImageReference[],
): QuestV2ImageResponse[] => images.map((image) => {
  const link = questV2Storage.linkForWithExpiry(image);
  return {
    imageId: image.imageId,
    fileId: image.fileId,
    position: image.position,
    url: link.url,
    urlExpiresAt: link.expiresAt.toISOString(),
  };
});

const questV2ImageIdempotencySelection = {
  id: walletIdempotencyKey.id,
  requestHash: walletIdempotencyKey.requestHash,
  resourceId: walletIdempotencyKey.resourceId,
  resultData: walletIdempotencyKey.resultData,
  processingStatus: walletIdempotencyKey.processingStatus,
  expiresAt: walletIdempotencyKey.expiresAt,
};

const findQuestV2ImageIdempotency = async (
  transaction: QuestTransaction,
  userId: string,
  operationScope: string,
  key: string,
) => {
  const [record] = await transaction
    .select(questV2ImageIdempotencySelection)
    .from(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.principalUserId, userId),
        eq(walletIdempotencyKey.operationScope, operationScope),
        eq(walletIdempotencyKey.key, key),
      ),
    )
    .limit(1)
    .for('update');

  return record;
};

const readQuestV2ImageReplay = (
  record: {
    requestHash: string;
    resourceId: string | null;
    resultData: unknown;
    processingStatus: string;
  },
  requestHash: string,
): QuestV2ImageUploadPreflight => {
  if (record.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (record.resourceId) {
    const snapshot = fromQuestV2ImageIdempotencySnapshot(record.resultData);
    return snapshot
      ? { replay: { images: snapshot.response } }
      : { outcome: 'idempotency-unavailable' };
  }
  return record.processingStatus === 'PROCESSING'
    ? { outcome: 'idempotency-in-progress' }
    : { outcome: 'idempotency-unavailable' };
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const imageRequestHash = (value: object): Promise<string> =>
  sha256Hex(new TextEncoder().encode(JSON.stringify(value)));

const normalizeQuestV2ImageCommandContext = (
  context: QuestV2ImageCommandContext,
): QuestV2ImageCommandContext | undefined => {
  const key = context.key.trim();
  if (key.length === 0 || key.length > 200) return undefined;

  return { ...context, key };
};

export const questV2ImageUploadRequestHash = async (
  userId: string,
  questId: string,
  images: File[],
): Promise<string> => {
  const files = [];
  for (const image of images) {
    const bytes = new Uint8Array(await image.arrayBuffer());
    files.push({
      name: image.name,
      contentType: image.type,
      sizeBytes: bytes.length,
      contentHash: await sha256Hex(bytes),
    });
  }

  return imageRequestHash({
    authenticatedMemberId: userId,
    operation: questV2ImageUploadOperationScope,
    path: questV2ImageUploadPath,
    questId,
    body: { images: files },
  });
};

export const questV2ImageRemoveRequestHash = (
  userId: string,
  questId: string,
  imageId: string,
): Promise<string> =>
  imageRequestHash({
    authenticatedMemberId: userId,
    operation: questV2ImageRemoveOperationScope,
    path: questV2ImageRemovePath,
    questId,
    body: { imageId },
  });

const lockQuestV2ImageOwner = async (
  transaction: QuestTransaction,
  context: QuestV2ImageCommandContext,
) => {
  const [ownedQuest] = await transaction
    .select({ id: quest.id, questStatus: quest.questStatus })
    .from(quest)
    .where(
      and(
        eq(quest.id, context.questId),
        eq(quest.hirerId, context.userId),
        eq(quest.apiVersion, questApiVersion.v2),
      ),
    )
    .limit(1)
    .for('update');

  return ownedQuest;
};

export const checkQuestV2ImageUpload = async (
  context: QuestV2ImageCommandContext,
  imageCount: number,
): Promise<QuestV2ImageUploadPreflight> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) {
    return { outcome: 'invalid-idempotency-key' };
  }

  return db.transaction(async (transaction) => {
    const existing = await findQuestV2ImageIdempotency(
      transaction,
      normalizedContext.userId,
      questV2ImageUploadOperationScope,
      normalizedContext.key,
    );
    if (
      existing &&
      !(
        existing.processingStatus === 'PROCESSING' &&
        existing.expiresAt <= new Date() &&
        !hasQuestV2ImageCleanupManifest(existing.resultData)
      )
    ) {
      return readQuestV2ImageReplay(existing, normalizedContext.requestHash);
    }

    const ownedQuest = await lockQuestV2ImageOwner(transaction, normalizedContext);
    if (!ownedQuest) return { outcome: 'not-found' };
    if (ownedQuest.questStatus !== questStatus.draft) return { outcome: 'not-draft' };

    const reservation = await acquireQuestV2Idempotency(
      transaction,
      normalizedContext.userId,
      questV2ImageUploadOperationScope,
      normalizedContext.key,
      normalizedContext.requestHash,
      false,
      true,
    );
    if ('outcome' in reservation) return reservation;
    if (!reservation.created) {
      return readQuestV2ImageReplay(reservation.record, normalizedContext.requestHash);
    }

    const [imageCountRow] = await transaction
      .select({ count: sql<number>`count(*)` })
      .from(questImage)
      .where(eq(questImage.questId, normalizedContext.questId));
    if (Number(imageCountRow?.count ?? 0) + imageCount > maxQuestV2Images) {
      await transaction
        .delete(walletIdempotencyKey)
        .where(eq(walletIdempotencyKey.id, reservation.record.id));
      return { outcome: 'limit-reached' };
    }

    return { canUpload: true };
  });
};

class QuestV2ImageCommandError extends Error {
  constructor(readonly outcome: Exclude<QuestV2ImageMutationOutcome, 'invalid-idempotency-key'>) {
    super(outcome);
    this.name = 'QuestV2ImageCommandError';
  }
}

const throwQuestV2ImageCommandError = (
  outcome: Exclude<QuestV2ImageMutationOutcome, 'invalid-idempotency-key'>,
): never => {
  throw new QuestV2ImageCommandError(outcome);
};

const addQuestV2ImagesInTransaction = async (
  transaction: QuestTransaction,
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[],
  allowExistingProcessing: boolean,
): Promise<QuestV2ImageUploadOutcome> => {
  const idempotency = await acquireQuestV2Idempotency(
    transaction,
    context.userId,
    questV2ImageUploadOperationScope,
    context.key,
    context.requestHash,
    allowExistingProcessing,
    true,
  );
  if ('outcome' in idempotency) return idempotency;

  if (!idempotency.created && idempotency.record.resourceId) {
    const snapshot = fromQuestV2ImageIdempotencySnapshot(idempotency.record.resultData);
    return snapshot
      ? { ...snapshot, replayed: true }
      : { outcome: 'idempotency-unavailable' };
  }

  const ownedQuest = await lockQuestV2ImageOwner(transaction, context);
  if (!ownedQuest) throwQuestV2ImageCommandError('not-found');
  if (ownedQuest.questStatus !== questStatus.draft) throwQuestV2ImageCommandError('not-draft');

  const [imageCountRow] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questImage)
    .where(eq(questImage.questId, context.questId));
  const currentCount = Number(imageCountRow?.count ?? 0);
  if (currentCount + images.length > maxQuestV2Images) {
    throwQuestV2ImageCommandError('limit-reached');
  }

  for (const [index, image] of images.entries()) {
    const [createdFile] = await transaction
      .insert(file)
      .values({ ...image, uploadedByUserId: context.userId })
      .returning({ id: file.id });
    if (!createdFile) throw new Error('Quest Image file could not be stored');

    await transaction.insert(questImage).values({
      questId: context.questId,
      fileId: createdFile.id,
      position: currentCount + index,
    });
  }

  const currentImages = await selectQuestV2Images(transaction, context.questId);
  const responseImages = materializeQuestV2ImageResponse(currentImages);
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-image',
      resourceId: context.questId,
      resultData: toQuestV2ImageIdempotencySnapshot(currentImages, responseImages),
      processingStatus: 'COMPLETED',
      completedAt: new Date(),
    })
    .where(eq(walletIdempotencyKey.id, idempotency.record.id));

  return { images: currentImages, response: responseImages };
};

export const addQuestV2Images = async (
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[],
): Promise<QuestV2ImageUploadOutcome> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) return { outcome: 'invalid-idempotency-key' };

  try {
    return await db.transaction((transaction) =>
      addQuestV2ImagesInTransaction(transaction, normalizedContext, images, true),
    );
  } catch (error) {
    if (error instanceof QuestV2ImageCommandError) return { outcome: error.outcome };
    throw error;
  }
};

export const releaseQuestV2ImageUploadReservation = async (
  context: QuestV2ImageCommandContext,
): Promise<void> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) return;

  await db
    .delete(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.principalUserId, normalizedContext.userId),
        eq(walletIdempotencyKey.operationScope, questV2ImageUploadOperationScope),
        eq(walletIdempotencyKey.key, normalizedContext.key),
        eq(walletIdempotencyKey.requestHash, normalizedContext.requestHash),
        eq(walletIdempotencyKey.processingStatus, 'PROCESSING'),
        isNull(walletIdempotencyKey.resourceId),
      ),
    );
};

type QuestV2ImageCleanupObject = {
  fileId: string;
  bucket: string;
  objectKey: string;
  deletedAt: Date | null;
};

type QuestV2ImageCleanupManifest = {
  images: StoredQuestImage[];
  deletedAt: string;
};

export class QuestV2ImageCleanupUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Quest Image cleanup retry could not be recorded', { cause });
    this.name = 'QuestV2ImageCleanupUnavailableError';
  }
}

const isStoredQuestImage = (value: unknown): value is StoredQuestImage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

  const image = value as Partial<StoredQuestImage>;
  return (
    typeof image.bucket === 'string' &&
    typeof image.objectKey === 'string' &&
    (image.contentType === 'image/jpeg' ||
      image.contentType === 'image/png' ||
      image.contentType === 'image/webp') &&
    typeof image.sizeBytes === 'number' &&
    Number.isInteger(image.sizeBytes) &&
    image.sizeBytes >= 0
  );
};

const toQuestV2ImageCleanupManifest = (
  images: StoredQuestImage[],
  deletedAt: Date,
): QuestV2ImageCleanupManifest => ({
  images,
  deletedAt: deletedAt.toISOString(),
});

const fromQuestV2ImageCleanupManifest = (
  resultData: unknown,
): QuestV2ImageCleanupManifest | undefined => {
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) {
    return undefined;
  }

  const result = resultData as { cleanup?: unknown };
  if (!result.cleanup || typeof result.cleanup !== 'object' || Array.isArray(result.cleanup)) {
    return undefined;
  }

  const manifest = result.cleanup as Partial<QuestV2ImageCleanupManifest>;
  const deletedAt = typeof manifest.deletedAt === 'string' ? new Date(manifest.deletedAt) : undefined;
  if (
    !Array.isArray(manifest.images) ||
    manifest.images.length === 0 ||
    manifest.images.some((image) => !isStoredQuestImage(image)) ||
    !deletedAt ||
    Number.isNaN(deletedAt.getTime())
  ) {
    return undefined;
  }

  return {
    images: manifest.images,
    deletedAt: deletedAt.toISOString(),
  };
};

const hasQuestV2ImageCleanupManifest = (resultData: unknown): boolean =>
  Boolean(fromQuestV2ImageCleanupManifest(resultData));

export const recordQuestV2ImageCleanupTombstones = async (
  userId: string,
  images: StoredQuestImage[],
  deletedAt = new Date(),
): Promise<void> => {
  if (images.length === 0) return;

  await db
    .insert(file)
    .values(
      images.map((image) => ({
        ...image,
        uploadedByUserId: userId,
        deletedAt,
      })),
    )
    .onConflictDoNothing();
};

export const recordQuestV2ImageCleanupRetry = async (
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[],
  deletedAt: Date,
): Promise<void> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext || images.length === 0) return;

  let updated: { id: string } | undefined;
  try {
    [updated] = await db
      .update(walletIdempotencyKey)
      .set({
        resultData: { cleanup: toQuestV2ImageCleanupManifest(images, deletedAt) },
        expiresAt: idempotencyExpiry(),
      })
      .where(
        and(
          eq(walletIdempotencyKey.principalUserId, normalizedContext.userId),
          eq(walletIdempotencyKey.operationScope, questV2ImageUploadOperationScope),
          eq(walletIdempotencyKey.key, normalizedContext.key),
          eq(walletIdempotencyKey.requestHash, normalizedContext.requestHash),
          eq(walletIdempotencyKey.processingStatus, 'PROCESSING'),
          isNull(walletIdempotencyKey.resourceId),
        ),
      )
      .returning({ id: walletIdempotencyKey.id });
  } catch (cause) {
    throw new QuestV2ImageCleanupUnavailableError(cause);
  }

  if (!updated) {
    throw new QuestV2ImageCleanupUnavailableError(
      new Error('Quest Image upload reservation was not available for cleanup retry'),
    );
  }
};

export const retryQuestV2ImageCleanupManifests = async (limit = 100): Promise<number> => {
  const pending = await db
    .select({
      id: walletIdempotencyKey.id,
      userId: walletIdempotencyKey.principalUserId,
      resultData: walletIdempotencyKey.resultData,
    })
    .from(walletIdempotencyKey)
    .where(
      and(
        eq(walletIdempotencyKey.operationScope, questV2ImageUploadOperationScope),
        eq(walletIdempotencyKey.processingStatus, 'PROCESSING'),
        isNull(walletIdempotencyKey.resourceId),
        sql`${walletIdempotencyKey.resultData} IS NOT NULL`,
      ),
    )
    .orderBy(asc(walletIdempotencyKey.id))
    .limit(limit);

  let retried = 0;
  for (const record of pending) {
    const manifest = fromQuestV2ImageCleanupManifest(record.resultData);
    if (!manifest) continue;

    try {
      await recordQuestV2ImageCleanupTombstones(
        record.userId,
        manifest.images,
        new Date(manifest.deletedAt),
      );
      await db.delete(walletIdempotencyKey).where(eq(walletIdempotencyKey.id, record.id));
      retried += 1;
    } catch (error) {
      console.error('[quest-image-cleanup] Cleanup tombstone retry failed', {
        error,
        idempotencyKeyId: record.id,
      });
    }
  }

  return retried;
};

const cleanupQuestV2ImageObject = async (object: QuestV2ImageCleanupObject): Promise<boolean> => {
  try {
    await questV2Storage.delete(object.bucket, object.objectKey);
    await db
      .update(file)
      .set({ objectDeletedAt: new Date() })
      .where(
        and(
          eq(file.id, object.fileId),
          isNull(file.objectDeletedAt),
          object.deletedAt ? eq(file.deletedAt, object.deletedAt) : sql`${file.deletedAt} IS NOT NULL`,
        ),
      );
    return true;
  } catch (error) {
    console.error('[quest-image-cleanup] Object deletion failed', {
      bucket: object.bucket,
      error,
      fileId: object.fileId,
      objectKey: object.objectKey,
    });
    return false;
  }
};

export const cleanupQuestV2ImageObjects = async (
  now = new Date(),
  limit = 100,
): Promise<number> => {
  const pending = await db
    .select({
      fileId: file.id,
      bucket: file.bucket,
      objectKey: file.objectKey,
      deletedAt: file.deletedAt,
    })
    .from(file)
    .where(
      and(
        like(file.objectKey, 'quests/v2/%'),
        sql`${file.deletedAt} IS NOT NULL`,
        isNull(file.objectDeletedAt),
        lte(file.deletedAt, now),
      ),
    )
    .orderBy(asc(file.deletedAt), asc(file.id))
    .limit(limit);

  const results = await Promise.all(pending.map((object) => cleanupQuestV2ImageObject(object)));
  return results.filter(Boolean).length;
};

const deleteQuestV2ImageInTransaction = async (
  transaction: QuestTransaction,
  context: QuestV2ImageCommandContext,
  imageId: string,
): Promise<QuestV2ImageRemoveOutcome & { cleanup?: QuestV2ImageCleanupObject }> => {
  const idempotency = await acquireQuestV2Idempotency(
    transaction,
    context.userId,
    questV2ImageRemoveOperationScope,
    context.key,
    context.requestHash,
  );
  if ('outcome' in idempotency) return idempotency;

  if (!idempotency.created && idempotency.record.resourceId) {
    const snapshot = fromQuestV2ImageIdempotencySnapshot(idempotency.record.resultData);
    return snapshot ? snapshot : { outcome: 'idempotency-unavailable' };
  }

  const ownedQuest = await lockQuestV2ImageOwner(transaction, context);
  if (!ownedQuest) throwQuestV2ImageCommandError('not-found');
  if (ownedQuest.questStatus !== questStatus.draft) throwQuestV2ImageCommandError('not-draft');

  const [image] = await transaction
    .select({
      imageId: questImage.id,
      fileId: file.id,
      bucket: file.bucket,
      objectKey: file.objectKey,
    })
    .from(questImage)
    .innerJoin(file, and(eq(questImage.fileId, file.id), isNull(file.deletedAt)))
    .where(and(eq(questImage.questId, context.questId), eq(questImage.id, imageId)))
    .limit(1)
    .for('update');
  if (!image) throwQuestV2ImageCommandError('not-found');

  const deletedAt = new Date();
  await softDeleteQuestImageAndRepack(transaction, {
    questId: context.questId,
    questImageId: image.imageId,
    fileId: image.fileId,
    deletedAt,
    positionOffset: maxQuestV2Images,
  });

  const currentImages = await selectQuestV2Images(transaction, context.questId);
  const responseImages = materializeQuestV2ImageResponse(currentImages);
  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest-image',
      resourceId: context.questId,
      resultData: toQuestV2ImageIdempotencySnapshot(currentImages, responseImages),
      processingStatus: 'COMPLETED',
      completedAt: deletedAt,
    })
    .where(eq(walletIdempotencyKey.id, idempotency.record.id));

  return {
    images: currentImages,
    response: responseImages,
    cleanup: {
      fileId: image.fileId,
      bucket: image.bucket,
      objectKey: image.objectKey,
      deletedAt,
    },
  };
};

export const deleteQuestV2Image = async (
  context: QuestV2ImageCommandContext,
  imageId: string,
): Promise<QuestV2ImageRemoveOutcome> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) return { outcome: 'invalid-idempotency-key' };

  let result: QuestV2ImageRemoveOutcome & { cleanup?: QuestV2ImageCleanupObject };
  try {
    result = await db.transaction((transaction) =>
      deleteQuestV2ImageInTransaction(transaction, normalizedContext, imageId),
    );
  } catch (error) {
    if (error instanceof QuestV2ImageCommandError) return { outcome: error.outcome };
    throw error;
  }

  if ('outcome' in result) return result;
  if ('cleanup' in result && result.cleanup) {
    await cleanupQuestV2ImageObject(result.cleanup);
  }

  return { images: result.images, response: result.response };
};

type QuestV2IdempotencySnapshot = Omit<QuestV2CanonicalQuest, 'questFundingTotal'> & {
  questFundingTotalSatang: Satang;
};

const toQuestV2IdempotencySnapshot = (
  canonicalQuest: QuestV2CanonicalQuest,
): QuestV2IdempotencySnapshot => {
  const questFundingTotalSatang = parseQuestFundingTotalSatang(canonicalQuest.questFundingTotal);
  if (!questFundingTotalSatang) {
    throw new Error(`Quest ${canonicalQuest.id} has an invalid Quest Funding Total`);
  }

  const { questFundingTotal: _questFundingTotal, ...canonicalFields } = canonicalQuest;
  return { ...canonicalFields, questFundingTotalSatang };
};

const fromQuestV2IdempotencySnapshot = (
  resultData: unknown,
): QuestV2CanonicalQuest | undefined => {
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) {
    return undefined;
  }

  const snapshot = resultData as Partial<QuestV2IdempotencySnapshot>;
  const questFundingTotalSatang = snapshot.questFundingTotalSatang;
  if (
    typeof questFundingTotalSatang !== 'number' ||
    !Number.isInteger(questFundingTotalSatang) ||
    questFundingTotalSatang < 100 ||
    questFundingTotalSatang > 70_000_000
  ) {
    return undefined;
  }

  const { questFundingTotalSatang: _questFundingTotalSatang, ...canonicalFields } = snapshot;
  return {
    ...canonicalFields,
    questFundingTotal: toBaht(satang(questFundingTotalSatang)),
  } as QuestV2CanonicalQuest;
};

type IdempotencyRecord = {
  id: string;
  requestHash: string;
  resourceId: string | null;
  resultData: unknown;
  processingStatus: string;
  expiresAt: Date;
};

const acquireQuestV2Idempotency = async (
  transaction: QuestTransaction,
  userId: string,
  operationScope: string,
  key: string,
  requestHash: string,
  allowExistingProcessing = false,
  recoverExpiredProcessing = false,
): Promise<
  | { created: true; record: IdempotencyRecord }
  | { created: false; record: IdempotencyRecord }
  | { outcome: 'idempotency-key-reused' | 'idempotency-in-progress' | 'idempotency-unavailable' }
> => {
  let [created] = await transaction
    .insert(walletIdempotencyKey)
    .values({
      principalUserId: userId,
      operationScope,
      key,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning({
      id: walletIdempotencyKey.id,
      requestHash: walletIdempotencyKey.requestHash,
      resourceId: walletIdempotencyKey.resourceId,
      resultData: walletIdempotencyKey.resultData,
      processingStatus: walletIdempotencyKey.processingStatus,
      expiresAt: walletIdempotencyKey.expiresAt,
    });

  let record = created
    ? created
    : (
        await transaction
          .select({
            id: walletIdempotencyKey.id,
            requestHash: walletIdempotencyKey.requestHash,
            resourceId: walletIdempotencyKey.resourceId,
            resultData: walletIdempotencyKey.resultData,
            processingStatus: walletIdempotencyKey.processingStatus,
            expiresAt: walletIdempotencyKey.expiresAt,
          })
          .from(walletIdempotencyKey)
          .where(
            and(
              eq(walletIdempotencyKey.principalUserId, userId),
              eq(walletIdempotencyKey.operationScope, operationScope),
              eq(walletIdempotencyKey.key, key),
            ),
          )
          .limit(1)
          .for('update')
      )[0];

  if (!record) return { outcome: 'idempotency-unavailable' };
  if (record.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (record.resourceId) return { created: false, record };
  if (
    !created &&
    recoverExpiredProcessing &&
    record.processingStatus === 'PROCESSING' &&
    !hasQuestV2ImageCleanupManifest(record.resultData) &&
    record.expiresAt <= new Date()
  ) {
    await transaction
      .delete(walletIdempotencyKey)
      .where(eq(walletIdempotencyKey.id, record.id));
    [created] = await transaction
      .insert(walletIdempotencyKey)
      .values({
        principalUserId: userId,
        operationScope,
        key,
        requestHash,
        expiresAt: idempotencyExpiry(),
      })
      .returning({
        id: walletIdempotencyKey.id,
        requestHash: walletIdempotencyKey.requestHash,
        resourceId: walletIdempotencyKey.resourceId,
        resultData: walletIdempotencyKey.resultData,
        processingStatus: walletIdempotencyKey.processingStatus,
        expiresAt: walletIdempotencyKey.expiresAt,
      });
    if (!created) return { outcome: 'idempotency-unavailable' };
    record = created;
  }
  if (
    !created &&
    allowExistingProcessing &&
    record.processingStatus === 'PROCESSING' &&
    !hasQuestV2ImageCleanupManifest(record.resultData)
  ) {
    return { created: true, record };
  }
  if (!created) return { outcome: 'idempotency-in-progress' };
  if (record.processingStatus !== 'PROCESSING') return { outcome: 'idempotency-unavailable' };

  return { created: true, record };
};

const throwInputError = (outcome: QuestV2CreateValidationOutcome): never => {
  throw new QuestV2InputError(outcome);
};

const createQuestInTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  key: string,
  input: NormalizedCreateInput,
  requestHash: string,
): Promise<QuestV2CreateOutcome> => {
  const idempotency = await acquireQuestV2Idempotency(
    transaction,
    userId,
    questV2CreateOperationScope,
    key,
    requestHash,
  );
  if ('outcome' in idempotency) return idempotency;

  if (!idempotency.created && idempotency.record.resourceId) {
    const snapshot = fromQuestV2IdempotencySnapshot(idempotency.record.resultData);
    if (snapshot) return { quest: snapshot };

    const replayed = await selectQuestV2Row(transaction, userId, idempotency.record.resourceId);
    if (!replayed) return { outcome: 'idempotency-unavailable' };

    return { quest: await buildCanonicalQuest(transaction, replayed) };
  }

  if (input.tagId) {
    const [existingTag] = await transaction
      .select({ id: tag.id })
      .from(tag)
      .where(eq(tag.id, input.tagId))
      .limit(1);
    if (!existingTag) throwInputError('tag-not-found');
  }

  // The unchanged v1 storage columns are required. These compatibility values
  // are internal and are never exposed by the v2 contract.
  const storageCompatibility = questV2StorageCompatibility(input);
  const [createdQuest] = await transaction
    .insert(quest)
    .values({
      hirerId: userId,
      apiVersion: questApiVersion.v2,
      title: input.title,
      description: input.description,
      condition: input.conditionItems.join('\n').slice(0, 4000),
      ...storageCompatibility,
      v2Mode: input.mode,
      v2Participation: input.participation,
      questStatus: questStatus.draft,
      questFundingTotalSatang: input.questFundingTotalSatang,
      tagId: input.tagId,
      headcount: input.headcount,
      startTime: input.startTime,
      dueAt: input.dueAt,
      proofRequired: input.proofRequired,
    })
    .returning({ id: quest.id });
  if (!createdQuest) return { outcome: 'idempotency-unavailable' };

  await transaction.insert(questConditionItem).values(
    input.conditionItems.map((text, position) => ({
      questId: createdQuest.id,
      position,
      text,
    })),
  );

  if (input.locations.length > 0) {
    await transaction.insert(questLocation).values(
      input.locations.map((location) => ({
        questId: createdQuest.id,
        label: location.label,
      })),
    );
  }

  const createdRow = await selectQuestV2Row(transaction, userId, createdQuest.id);
  if (!createdRow) return { outcome: 'idempotency-unavailable' };
  const canonicalQuest = await buildCanonicalQuest(transaction, createdRow);

  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest',
      resourceId: createdQuest.id,
      resultData: toQuestV2IdempotencySnapshot(canonicalQuest),
      processingStatus: 'COMPLETED',
      completedAt: new Date(),
    })
    .where(eq(walletIdempotencyKey.id, idempotency.record.id));

  return { quest: canonicalQuest };
};

export const createQuestV2 = async (
  userId: string,
  data: QuestV2CreateInput,
  rawIdempotencyKey: string,
): Promise<QuestV2CreateOutcome> => {
  const key = rawIdempotencyKey.trim();
  if (key.length === 0 || key.length > 200) return { outcome: 'invalid-idempotency-key' };

  const input = normalizeCreateInput(data);
  if ('outcome' in input) return input;

  const requestHash = await requestHashFor(userId, input);

  try {
    return await db.transaction((transaction) =>
      createQuestInTransaction(transaction, userId, key, input, requestHash),
    );
  } catch (error) {
    if (error instanceof QuestV2InputError) return { outcome: error.outcome };
    throw error;
  }
};

const throwEditError = (outcome: QuestV2EditOutcomeCode): never => {
  throw new QuestV2EditError(outcome);
};

const editQuestV2InTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  key: string,
  expectedVersion: number,
  input: NormalizedEditInput,
  requestHash: string,
): Promise<QuestV2EditOutcome> => {
  const idempotency = await acquireQuestV2Idempotency(
    transaction,
    userId,
    questV2EditOperationScope,
    key,
    requestHash,
  );
  if ('outcome' in idempotency) return idempotency;

  if (!idempotency.created && idempotency.record.resourceId) {
    const snapshot = fromQuestV2IdempotencySnapshot(idempotency.record.resultData);
    if (snapshot) return { quest: snapshot };

    const replayed = await selectQuestV2Row(transaction, userId, idempotency.record.resourceId);
    if (!replayed) return { outcome: 'idempotency-unavailable' };

    return { quest: await buildCanonicalQuest(transaction, replayed) };
  }

  const [current] = await transaction
    .select({
      id: quest.id,
      version: quest.version,
      title: quest.title,
      description: quest.description,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      questStatus: quest.questStatus,
      headcount: quest.headcount,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
      proofRequired: quest.proofRequired,
      tagId: quest.tagId,
    })
    .from(quest)
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.hirerId, userId),
        eq(quest.apiVersion, questApiVersion.v2),
      ),
    )
    .limit(1)
    .for('update');

  if (!current) throwEditError('not-found');
  if (current.questStatus !== questStatus.draft) throwEditError('not-draft');
  if (current.version !== expectedVersion) throwEditError('conflict');
  if (!current.v2Mode || !current.v2Participation) {
    throw new Error(`Quest ${questId} has incomplete v2 persistence data`);
  }

  const nextParticipation = input.participation ?? current.v2Participation;
  const nextHeadcount = input.headcount ?? current.headcount;
  if (nextParticipation === questV2Participation.single && nextHeadcount !== 1) {
    throwEditError('invalid-headcount');
  }

  const nextStartTime = input.startTime ?? current.startTime;
  const nextDueAt = input.dueAt === undefined ? current.dueAt : input.dueAt;
  if (nextDueAt !== null && nextDueAt <= nextStartTime) throwEditError('invalid-dates');

  if (input.tagId) {
    const [existingTag] = await transaction
      .select({ id: tag.id })
      .from(tag)
      .where(eq(tag.id, input.tagId))
      .limit(1);
    if (!existingTag) throwEditError('tag-not-found');
  }

  const now = new Date();
  const updates: Partial<Omit<typeof quest.$inferInsert, 'version'>> = { updatedAt: now };

  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.questFundingTotalSatang !== undefined) {
    updates.questFundingTotalSatang = input.questFundingTotalSatang;
  }
  if (input.headcount !== undefined) updates.headcount = input.headcount;
  if (input.startTime !== undefined) updates.startTime = input.startTime;
  if (input.dueAt !== undefined) updates.dueAt = input.dueAt;
  if (input.tagId !== undefined) updates.tagId = input.tagId;
  if (input.proofRequired !== undefined) updates.proofRequired = input.proofRequired;

  if (input.mode !== undefined || input.participation !== undefined) {
    const storageCompatibility = questV2StorageCompatibility({
      mode: input.mode ?? current.v2Mode,
      participation: nextParticipation,
    });
    updates.mode = storageCompatibility.mode;
    updates.participation = storageCompatibility.participation;
    updates.v2Mode = input.mode ?? current.v2Mode;
    updates.v2Participation = nextParticipation;
  }

  if (input.conditionItems !== undefined) {
    updates.condition = input.conditionItems.join('\n').slice(0, 4000);
    await transaction.delete(questConditionItem).where(eq(questConditionItem.questId, questId));
    await transaction.insert(questConditionItem).values(
      input.conditionItems.map((text, position) => ({ questId, position, text })),
    );
  }

  if (input.locations !== undefined) {
    await transaction.delete(questLocation).where(eq(questLocation.questId, questId));
    if (input.locations.length > 0) {
      await transaction.insert(questLocation).values(
        input.locations.map((location) => ({ questId, label: location.label })),
      );
    }
  }

  const [updated] = await transaction
    .update(quest)
    .set({ ...updates, version: sql`${quest.version} + 1` })
    .where(
      and(
        eq(quest.id, questId),
        eq(quest.hirerId, userId),
        eq(quest.apiVersion, questApiVersion.v2),
        eq(quest.questStatus, questStatus.draft),
        eq(quest.version, expectedVersion),
      ),
    )
    .returning({ id: quest.id });
  if (!updated) throwEditError('conflict');

  const updatedRow = await selectQuestV2Row(transaction, userId, questId);
  if (!updatedRow) return { outcome: 'idempotency-unavailable' };
  const canonicalQuest = await buildCanonicalQuest(transaction, updatedRow);

  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest',
      resourceId: questId,
      resultData: toQuestV2IdempotencySnapshot(canonicalQuest),
      processingStatus: 'COMPLETED',
      completedAt: now,
    })
    .where(eq(walletIdempotencyKey.id, idempotency.record.id));

  return { quest: canonicalQuest };
};

export const editQuestV2 = async (
  userId: string,
  questId: string,
  data: QuestV2EditInput,
  expectedVersion: number,
  rawIdempotencyKey: string,
): Promise<QuestV2EditOutcome> => {
  const key = rawIdempotencyKey.trim();
  if (key.length === 0 || key.length > 200) return { outcome: 'invalid-idempotency-key' };
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { outcome: 'invalid-version' };
  }

  const input = normalizeEditInput(data);
  if ('outcome' in input) return input;

  const requestHash = await editRequestHashFor(userId, questId, expectedVersion, input);

  try {
    return await db.transaction((transaction) =>
      editQuestV2InTransaction(
        transaction,
        userId,
        questId,
        key,
        expectedVersion,
        input,
        requestHash,
      ),
    );
  } catch (error) {
    if (error instanceof QuestV2EditError) return { outcome: error.outcome };
    throw error;
  }
};

export const listOwnQuestV2 = async (
  userId: string,
  filters: { limit?: number; cursor?: string },
) => {
  const limit = parsePageLimit(filters.limit);
  const cursor = decodeCursor(filters.cursor);
  const conditions = [
    eq(quest.apiVersion, questApiVersion.v2),
    eq(quest.hirerId, userId),
  ];

  if (cursor) {
    const startTime = new Date(cursor.startTime);
    const cursorCondition = or(
      gt(quest.startTime, startTime),
      and(eq(quest.startTime, startTime), gt(quest.id, cursor.id)),
    );
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = (await db
    .select(questV2RowSelection)
    .from(quest)
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(and(...conditions))
    .orderBy(asc(quest.startTime), asc(quest.id))
    .limit(limit + 1)) as QuestV2Row[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = await Promise.all(page.map((row) => buildCanonicalQuest(db, row)));
  const last = page[page.length - 1];

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ id: last.id, startTime: last.startTime.toISOString() })
        : null,
  };
};

export const getQuestV2Detail = async (
  userId: string,
  questId: string,
): Promise<QuestV2Detail | undefined> => {
  const row = await selectQuestV2Row(db, userId, questId);
  if (!row) return undefined;

  const [canonicalQuest, images] = await Promise.all([
    buildCanonicalQuest(db, row),
    selectQuestV2Images(db, questId),
  ]);
  return { ...canonicalQuest, images };
};

export const getQuestV2PublishCheck = async (
  userId: string,
  questId: string,
): Promise<QuestV2PublishCheckOutcome | undefined> =>
  db.transaction(async (transaction) => {
    const row = await selectQuestV2Row(transaction, userId, questId);
    if (!row) return undefined;
    if (row.questStatus !== questStatus.draft) return { outcome: 'not-draft' };
    if (row.questFundingTotalSatang === null) {
      throw new Error(`Quest ${questId} has incomplete v2 persistence data`);
    }

    const [conditionItems, policy, wallet] = await Promise.all([
      selectConditionItems(transaction, questId),
      getEffectiveFundingReservationPolicy(transaction),
      transaction
        .select({
          spendingBalanceSatang: walletWallet.spendingBalanceSatang,
          walletStatus: walletWallet.walletStatus,
        })
        .from(walletWallet)
        .where(eq(walletWallet.userId, userId))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    if (!wallet) {
      throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
    }

    return buildQuestV2PublishCheck({
      tagId: row.tagId,
      conditionValid: conditionItems.length > 0 && conditionItems.every((item, position) => {
        const text = item.text.trim();
        return item.position === position && text.length > 0 && text.length <= 255;
      }),
      startTime: row.startTime,
      dueAt: row.dueAt,
      now: new Date(),
      questFundingTotalSatang: satang(row.questFundingTotalSatang),
      headcount: row.headcount,
      spendingBalanceSatang: satang(wallet.spendingBalanceSatang),
      walletStatus: wallet.walletStatus,
      platformFeeBps: policy.platformFeeBps,
      feeRoundingMode: policy.feeRoundingMode as 'UP',
      policyRevisionId: policy.id,
      policyRevision: policy.revision,
      minimumFundingReservationSatang: satang(policy.minimumFundingReservationSatang),
      maximumFundingReservationSatang: satang(policy.maximumFundingReservationSatang),
    });
  });
