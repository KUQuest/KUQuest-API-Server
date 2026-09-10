import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import {
  quest,
  questAssignment,
  questApiVersion,
  questCommand,
  questConditionItem,
  questImage,
  questLocation,
} from '@/database/schema/quest.schema';
import { file } from '@/database/schema/file.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletWallet } from '@/database/schema/wallet.schema';
import {
  getEffectiveFundingReservationPolicy,
  MoneyDomainError,
  positiveSatang,
  reserveSpending,
  satang,
  toBaht,
  type Satang,
} from '@/modules/wallet';
import { decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import {
  completeQuestCommand,
  findOpenQuestCommandPayloads,
  openQuestCommand,
  parkQuestCommandPayload,
  runQuestCommand,
  sha256Json,
  type QuestCommandOutcomeCode,
  type QuestCommandWork,
} from './quest-command.service';
import { assignmentStatus, questStatus, type QuestStatus } from './quest.contract';
import { questV2StorageCompatibility } from './quest-storage.adapter';
import {
  formatQuestV2ScheduleTime,
  isQuestV2ScheduleTime,
  isValidQuestV2Headcount,
  questV2States,
  type QuestV2CanonicalQuest,
  type QuestV2Mode,
  type QuestV2Participation,
  type QuestV2State,
} from './quest-v2.contract';
import { buildQuestV2PublishCheck, type QuestV2PublishCheck } from './quest-v2.publish.policy';
import { softDeleteQuestImageAndRepack } from './quest-image.service';
import { maxQuestV2Images } from './quest-v2.schema';
import type { QuestV2BoardQuery, QuestV2CreateInput, QuestV2EditInput } from './quest-v2.schema';
import { questV2Storage, type StoredQuestImage } from './quest.storage';

type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuestDatabase = typeof db | QuestTransaction;

export const questV2CreateOperationScope = 'quest.v2.create';
export const questV2EditOperationScope = 'quest.v2.edit';
export const questV2PublishOperationScope = 'quest.v2.publish';
export const questV2ImageUploadOperationScope = 'quest.v2.image.upload';
export const questV2ImageRemoveOperationScope = 'quest.v2.image.remove';
const questV2CreatePath = '/api/v2/quests';
const questV2EditPath = '/api/v2/quests/:questId';
const questV2PublishPath = '/api/v2/quests/:questId/publish';
const questV2ImageUploadPath = '/api/v2/quests/:questId/images';
const questV2ImageRemovePath = '/api/v2/quests/:questId/images/:imageId';

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
        QuestV2CreateValidationOutcome | 'idempotency-key-reused' | 'idempotency-in-progress';
    };

export type QuestV2EditOutcome =
  { quest: QuestV2CanonicalQuest } | { outcome: QuestV2EditOutcomeCode };

export type QuestV2PublishCheckOutcome = QuestV2PublishCheck | { outcome: 'not-draft' };

export type QuestV2QuestEscrowSnapshot = {
  reservationId: string;
  questFundingTotal: number;
  questFundingTotalSatang: Satang;
  questReward: number;
  questRewardSatang: Satang;
  platformFee: number;
  platformFeeSatang: Satang;
  escrowRequirement: number;
  escrowRequirementSatang: Satang;
  headcount: number;
  platformFeeBps: number;
  feeRoundingMode: 'UP';
  policyRevisionId: string;
  policyRevision: number;
};

export type QuestV2PublishResponse = {
  quest: QuestV2CanonicalQuest;
  questEscrow: QuestV2QuestEscrowSnapshot;
};

export type QuestV2PublishOutcome =
  | QuestV2PublishResponse
  | { outcome: 'blocked'; check: QuestV2PublishCheck }
  | {
      outcome:
        | 'invalid-idempotency-key'
        | 'idempotency-key-reused'
        | 'idempotency-in-progress'
        | 'idempotency-unavailable'
        | 'not-draft';
    };

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

export type QuestV2BoardCard = {
  id: string;
  title: string;
  questReward: number;
  tag: { id: string; name: string };
  mode: QuestV2Mode;
  participation: QuestV2Participation;
  headcount: number;
  activeWorkerCount: number;
  startTime: string;
  dueAt: string;
  hirerName: string;
  location: string | null;
};

export type QuestV2PublicImageResponse = {
  imageId: string;
  position: number;
  url: string;
  urlExpiresAt: string;
};

export type QuestV2PublicDetail = {
  id: string;
  title: string;
  description: string | null;
  condition: QuestV2CanonicalQuest['condition'];
  tag: { id: string; name: string };
  mode: QuestV2Mode;
  participation: QuestV2Participation;
  state: QuestV2State;
  questReward: number;
  headcount: number;
  activeWorkerCount: number;
  startTime: string;
  dueAt: string;
  proofRequired: boolean;
  hirerName: string;
  locations: Array<{ label: string }>;
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
  hiddenAt: Date | null;
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

type QuestV2BoardRow = {
  id: string;
  title: string;
  rewardSatang: number | null;
  tagId: string | null;
  tagName: string | null;
  v2Mode: QuestV2Mode | null;
  v2Participation: QuestV2Participation | null;
  headcount: number;
  activeWorkerCount: number;
  startTime: Date;
  dueAt: Date | null;
  hirerFirstName: string;
  hirerLastName: string;
};

type QuestV2PublicDetailRow = QuestV2BoardRow & {
  description: string | null;
  questStatus: QuestStatus;
  proofRequired: boolean;
};

type CompleteQuestV2DiscoveryRow = QuestV2BoardRow & {
  rewardSatang: number;
  tagId: string;
  tagName: string;
  v2Mode: QuestV2Mode;
  v2Participation: QuestV2Participation;
  dueAt: Date;
};

const isCompleteQuestV2DiscoveryRow = (row: QuestV2BoardRow): row is CompleteQuestV2DiscoveryRow =>
  row.rewardSatang !== null &&
  row.tagId !== null &&
  row.tagName !== null &&
  row.v2Mode !== null &&
  row.v2Participation !== null &&
  row.dueAt !== null;

const questV2RowSelection = {
  id: quest.id,
  version: quest.version,
  hiddenAt: quest.hiddenAt,
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
  data: QuestV2CreateInput
):
  | NormalizedCreateInput
  | {
      outcome: Exclude<QuestV2CreateValidationOutcome, 'tag-not-found' | 'idempotency-unavailable'>;
    } => {
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
    !isQuestV2ScheduleTime(data.startTime) ||
    (typeof data.dueAt === 'string' && !isQuestV2ScheduleTime(data.dueAt)) ||
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

  if (!isValidQuestV2Headcount(data.participation, data.headcount)) {
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
    label: location && typeof location.label === 'string' ? location.label.trim() : null,
  }));
  const locations = normalizedLocations.filter(
    (location): location is { label: string } =>
      location.label !== null && location.label.length > 0 && location.label.length <= 100
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
  field: K
): data is QuestV2EditInput & Required<Pick<QuestV2EditInput, K>> =>
  Object.prototype.hasOwnProperty.call(data, field);

const normalizeEditInput = (
  data: QuestV2EditInput
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
      typeof item === 'string' ? item.trim() : ''
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
    if (typeof data.startTime !== 'string' || !isQuestV2ScheduleTime(data.startTime)) {
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
      if (typeof data.dueAt !== 'string' || !isQuestV2ScheduleTime(data.dueAt)) {
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
  input: NormalizedEditInput
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
  lock = false
): Promise<QuestV2Row | undefined> => {
  const ownerCondition = and(
    eq(quest.id, questId),
    eq(quest.hirerId, userId),
    eq(quest.apiVersion, questApiVersion.v2)
  );

  // Lock the Quest table row separately. PostgreSQL does not allow FOR UPDATE
  // on the nullable side of the left join used to read the optional Tag.
  if (lock) {
    const [lockedQuest] = await database
      .select({ id: quest.id })
      .from(quest)
      .where(ownerCondition)
      .limit(1)
      .for('update');
    if (!lockedQuest) return undefined;
  }

  const [row] = await database
    .select(questV2RowSelection)
    .from(quest)
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(ownerCondition)
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
  row: QuestV2Row
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
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    title: row.title,
    description: row.description,
    condition: { items: conditionItems },
    tag: row.tagId && row.tagName ? { id: row.tagId, name: row.tagName } : null,
    mode: row.v2Mode,
    participation: row.v2Participation,
    state: toV2State(row.questStatus),
    questFundingTotal: toBaht(questFundingTotalSatang),
    headcount: row.headcount,
    startTime: formatQuestV2ScheduleTime(row.startTime),
    dueAt: row.dueAt ? formatQuestV2ScheduleTime(row.dueAt) : null,
    proofRequired: row.proofRequired,
    locations,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};

const buildQuestV2PublishCheckForRow = async (
  database: QuestTransaction,
  userId: string,
  row: QuestV2Row,
  lockWallet: boolean
): Promise<QuestV2PublishCheck> => {
  if (row.questFundingTotalSatang === null || !row.v2Participation) {
    throw new Error(`Quest ${row.id} has incomplete v2 persistence data`);
  }

  const conditionItems = await selectConditionItems(database, row.id);
  const policy = await getEffectiveFundingReservationPolicy(database);
  const walletQuery = database
    .select({
      spendingBalanceSatang: walletWallet.spendingBalanceSatang,
      walletStatus: walletWallet.walletStatus,
    })
    .from(walletWallet)
    .where(eq(walletWallet.userId, userId))
    .limit(1);
  const [wallet] = lockWallet ? await walletQuery.for('update') : await walletQuery;

  if (!wallet) {
    throw new MoneyDomainError('WALLET_NOT_FOUND', 'Wallet does not exist.');
  }

  return buildQuestV2PublishCheck({
    participation: row.v2Participation,
    tagId: row.tagId,
    conditionValid:
      conditionItems.length > 0 &&
      conditionItems.every((item, position) => {
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
};

const selectQuestV2Images = async (
  database: QuestDatabase,
  questId: string
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

type QuestV2ImageUploadObject = Pick<StoredQuestImage, 'bucket' | 'objectKey'>;

type QuestV2ImageUploadManifest = {
  upload: {
    objects: QuestV2ImageUploadObject[];
  };
};

const toQuestV2ImageUploadManifest = (
  objects: QuestV2ImageUploadObject[]
): QuestV2ImageUploadManifest => ({
  upload: {
    objects: objects.map(({ bucket, objectKey }) => ({ bucket, objectKey })),
  },
});

const fromQuestV2ImageUploadManifest = (
  resultData: unknown
): QuestV2ImageUploadManifest | undefined => {
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) {
    return undefined;
  }

  const result = resultData as { upload?: unknown };
  if (!result.upload || typeof result.upload !== 'object' || Array.isArray(result.upload)) {
    return undefined;
  }

  const manifest = result.upload as Partial<QuestV2ImageUploadManifest['upload']>;
  if (
    !Array.isArray(manifest.objects) ||
    manifest.objects.length === 0 ||
    manifest.objects.some((object) => {
      if (!object || typeof object !== 'object' || Array.isArray(object)) return true;
      const value = object as Partial<QuestV2ImageUploadObject>;
      return typeof value.bucket !== 'string' || typeof value.objectKey !== 'string';
    })
  ) {
    return undefined;
  }

  return {
    upload: {
      objects: manifest.objects,
    },
  };
};

type QuestV2ImageIdempotencySnapshot = {
  images: QuestV2ImageReference[];
  response: QuestV2ImageResponse[];
};

const toQuestV2ImageIdempotencySnapshot = (
  images: QuestV2ImageReference[],
  response: QuestV2ImageResponse[]
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
  resultData: unknown
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

export const materializeQuestV2ImageResponse = (
  images: QuestV2ImageReference[]
): QuestV2ImageResponse[] =>
  images.map((image) => {
    const link = questV2Storage.linkForWithExpiry(image);
    return {
      imageId: image.imageId,
      fileId: image.fileId,
      position: image.position,
      url: link.url,
      urlExpiresAt: link.expiresAt.toISOString(),
    };
  });

type QuestV2ImageCommandRecord = {
  id: string;
  requestHash: string;
  resultData: unknown;
  processingStatus: string;
  expiresAt?: Date;
};

const questV2ImageCommandSelection = {
  id: questCommand.id,
  requestHash: questCommand.requestHash,
  resultData: questCommand.resultData,
  processingStatus: questCommand.processingStatus,
  expiresAt: questCommand.expiresAt,
};

const findQuestV2ImageCommand = async (
  transaction: QuestTransaction,
  context: QuestV2ImageCommandContext,
  operationScope: string
): Promise<QuestV2ImageCommandRecord | undefined> => {
  const [record] = await transaction
    .select(questV2ImageCommandSelection)
    .from(questCommand)
    .where(
      and(
        eq(questCommand.principalUserId, context.userId),
        eq(questCommand.operationScope, operationScope),
        eq(questCommand.key, context.key)
      )
    )
    .limit(1)
    .for('update');
  return record;
};

const imageCommandBusinessOutcomes: readonly string[] = ['not-found', 'not-draft', 'limit-reached'];

type QuestV2ImageCommandRead =
  | { kind: 'success'; snapshot: QuestV2ImageIdempotencySnapshot }
  | { kind: 'rejected'; outcome: QuestV2ImageMutationOutcome }
  | { outcome: 'idempotency-key-reused' | 'idempotency-in-progress' | 'idempotency-unavailable' };

const readQuestV2ImageCommand = (
  record: QuestV2ImageCommandRecord,
  requestHash: string
): QuestV2ImageCommandRead => {
  if (record.requestHash !== requestHash) return { outcome: 'idempotency-key-reused' };
  if (record.processingStatus === 'PROCESSING') {
    return { outcome: 'idempotency-in-progress' };
  }
  if (record.processingStatus !== 'COMPLETED') {
    return { outcome: 'idempotency-unavailable' };
  }

  if (!record.resultData || typeof record.resultData !== 'object') {
    return { outcome: 'idempotency-unavailable' };
  }
  const envelope = record.resultData as { kind?: unknown; result?: unknown; rejection?: unknown };
  if (envelope.kind === 'success') {
    const snapshot = fromQuestV2ImageIdempotencySnapshot(envelope.result);
    return snapshot ? { kind: 'success', snapshot } : { outcome: 'idempotency-unavailable' };
  }
  if (envelope.kind === 'rejected' && typeof envelope.rejection === 'string') {
    if (imageCommandBusinessOutcomes.includes(envelope.rejection)) {
      return {
        kind: 'rejected',
        outcome: envelope.rejection as QuestV2ImageMutationOutcome,
      };
    }
    if (envelope.rejection === 'idempotency-unavailable') {
      return { outcome: 'idempotency-unavailable' };
    }
  }
  return { outcome: 'idempotency-unavailable' };
};

const readQuestV2ImageReplay = (
  record: QuestV2ImageCommandRecord,
  requestHash: string
): QuestV2ImageUploadPreflight => {
  const result = readQuestV2ImageCommand(record, requestHash);
  if ('kind' in result && result.kind === 'success') {
    return { replay: { images: result.snapshot.response } };
  }
  if ('kind' in result && result.kind === 'rejected') {
    return { outcome: result.outcome };
  }
  return result;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const imageRequestHash = (value: object): Promise<string> => sha256Json(value);

const normalizeQuestV2ImageCommandContext = (
  context: QuestV2ImageCommandContext
): QuestV2ImageCommandContext | undefined => {
  const key = context.key.trim();
  if (key.length === 0 || key.length > 200) return undefined;

  return { ...context, key };
};

export const questV2ImageUploadRequestHash = async (
  userId: string,
  questId: string,
  images: File[]
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
  imageId: string
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
  context: QuestV2ImageCommandContext
) => {
  const [ownedQuest] = await transaction
    .select({ id: quest.id, questStatus: quest.questStatus })
    .from(quest)
    .where(
      and(
        eq(quest.id, context.questId),
        eq(quest.hirerId, context.userId),
        eq(quest.apiVersion, questApiVersion.v2)
      )
    )
    .limit(1)
    .for('update');

  return ownedQuest;
};

export const checkQuestV2ImageUpload = async (
  context: QuestV2ImageCommandContext,
  imageCount: number,
  plannedObjects: QuestV2ImageUploadObject[]
): Promise<QuestV2ImageUploadPreflight> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) {
    return { outcome: 'invalid-idempotency-key' };
  }

  return db.transaction(async (transaction) => {
    const ownedQuest = await lockQuestV2ImageOwner(transaction, normalizedContext);
    if (!ownedQuest) return { outcome: 'not-found' };

    const existing = await findQuestV2ImageCommand(
      transaction,
      normalizedContext,
      questV2ImageUploadOperationScope
    );
    const now = new Date();
    if (existing) {
      const canRecover =
        existing.requestHash === normalizedContext.requestHash &&
        existing.processingStatus === 'PROCESSING' &&
        existing.resultData === null &&
        existing.expiresAt !== undefined &&
        existing.expiresAt <= now;
      if (canRecover) {
        if (ownedQuest.questStatus !== questStatus.draft) return { outcome: 'not-draft' };
        const [imageCountRow] = await transaction
          .select({ count: sql<number>`count(*)` })
          .from(questImage)
          .where(eq(questImage.questId, normalizedContext.questId));
        const exceedsLimit = Number(imageCountRow?.count ?? 0) + imageCount > maxQuestV2Images;
        if (exceedsLimit) {
          await completeQuestCommand({
            executor: transaction,
            id: existing.id,
            payload: { kind: 'rejected', rejection: 'limit-reached' },
            now,
          });
          return { outcome: 'limit-reached' };
        }
        const parked = await parkQuestCommandPayload({
          executor: transaction,
          identity: {
            principalUserId: normalizedContext.userId,
            operationScope: questV2ImageUploadOperationScope,
            key: normalizedContext.key,
            requestHash: normalizedContext.requestHash,
            questId: normalizedContext.questId,
          },
          payload: toQuestV2ImageUploadManifest(plannedObjects),
          now,
        });
        return parked ? { canUpload: true } : { outcome: 'idempotency-unavailable' };
      }
      return readQuestV2ImageReplay(existing, normalizedContext.requestHash);
    }
    if (ownedQuest.questStatus !== questStatus.draft) return { outcome: 'not-draft' };

    const [imageCountRow] = await transaction
      .select({ count: sql<number>`count(*)` })
      .from(questImage)
      .where(eq(questImage.questId, normalizedContext.questId));
    const exceedsLimit = Number(imageCountRow?.count ?? 0) + imageCount > maxQuestV2Images;
    const commandId = await openQuestCommand({
      executor: transaction,
      identity: {
        principalUserId: normalizedContext.userId,
        operationScope: questV2ImageUploadOperationScope,
        key: normalizedContext.key,
        requestHash: normalizedContext.requestHash,
        questId: normalizedContext.questId,
      },
      payload: toQuestV2ImageUploadManifest(plannedObjects),
      now,
    });
    if (exceedsLimit) {
      await completeQuestCommand({
        executor: transaction,
        id: commandId,
        payload: { kind: 'rejected', rejection: 'limit-reached' },
        now,
      });
      return { outcome: 'limit-reached' };
    }

    // Commit the object targets before any storage write so a crashed request remains recoverable.
    return { canUpload: true };
  });
};

const addQuestV2ImagesInTransaction = async (
  transaction: QuestTransaction,
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[]
): Promise<QuestV2ImageUploadOutcome> => {
  const ownedQuest = await lockQuestV2ImageOwner(transaction, context);
  if (!ownedQuest) return { outcome: 'not-found' };

  let command = await findQuestV2ImageCommand(
    transaction,
    context,
    questV2ImageUploadOperationScope
  );
  if (command && command.requestHash !== context.requestHash) {
    return { outcome: 'idempotency-key-reused' };
  }

  if (command?.processingStatus === 'COMPLETED') {
    const replay = readQuestV2ImageCommand(command, context.requestHash);
    if ('kind' in replay && replay.kind === 'success') {
      return { ...replay.snapshot, replayed: true };
    }
    if ('kind' in replay && replay.kind === 'rejected') {
      return { outcome: replay.outcome };
    }
    return replay;
  }
  if (
    command?.processingStatus === 'PROCESSING' &&
    !fromQuestV2ImageUploadManifest(command.resultData)
  ) {
    return { outcome: 'idempotency-in-progress' };
  }

  const now = new Date();
  if (!command) {
    const commandId = await openQuestCommand({
      executor: transaction,
      identity: {
        principalUserId: context.userId,
        operationScope: questV2ImageUploadOperationScope,
        key: context.key,
        requestHash: context.requestHash,
        questId: context.questId,
      },
      payload: toQuestV2ImageUploadManifest(images),
      now,
    });
    command = {
      id: commandId,
      requestHash: context.requestHash,
      resultData: toQuestV2ImageUploadManifest(images),
      processingStatus: 'PROCESSING',
    };
  }
  if (!command) return { outcome: 'idempotency-unavailable' };

  if (ownedQuest.questStatus !== questStatus.draft) {
    await completeQuestCommand({
      executor: transaction,
      id: command.id,
      payload: { kind: 'rejected', rejection: 'not-draft' },
      now,
    });
    return { outcome: 'not-draft' };
  }

  const [imageCountRow] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questImage)
    .where(eq(questImage.questId, context.questId));
  const currentCount = Number(imageCountRow?.count ?? 0);
  if (currentCount + images.length > maxQuestV2Images) {
    await completeQuestCommand({
      executor: transaction,
      id: command.id,
      payload: { kind: 'rejected', rejection: 'limit-reached' },
      now,
    });
    return { outcome: 'limit-reached' };
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

  const imageReferences = await selectQuestV2Images(transaction, context.questId);
  const response = materializeQuestV2ImageResponse(imageReferences);
  const completed = await completeQuestCommand({
    executor: transaction,
    id: command.id,
    payload: {
      kind: 'success',
      result: toQuestV2ImageIdempotencySnapshot(imageReferences, response),
    },
    now,
  });
  if (!completed) return { outcome: 'idempotency-unavailable' };
  return { images: imageReferences, response };
};

export const addQuestV2Images = async (
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[]
): Promise<QuestV2ImageUploadOutcome> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) return { outcome: 'invalid-idempotency-key' };

  return db.transaction((transaction) =>
    addQuestV2ImagesInTransaction(transaction, normalizedContext, images)
  );
};

export const releaseQuestV2ImageUploadReservation = async (
  context: QuestV2ImageCommandContext
): Promise<void> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) return;

  const [command] = await db
    .select({
      id: questCommand.id,
      requestHash: questCommand.requestHash,
      processingStatus: questCommand.processingStatus,
    })
    .from(questCommand)
    .where(
      and(
        eq(questCommand.principalUserId, normalizedContext.userId),
        eq(questCommand.operationScope, questV2ImageUploadOperationScope),
        eq(questCommand.key, normalizedContext.key)
      )
    )
    .limit(1);
  if (
    !command ||
    command.requestHash !== normalizedContext.requestHash ||
    command.processingStatus !== 'PROCESSING'
  ) {
    return;
  }

  await completeQuestCommand({
    executor: db,
    id: command.id,
    payload: { kind: 'rejected', rejection: 'idempotency-unavailable' },
    now: new Date(),
  });
};

type QuestV2ImageTombstone = {
  fileId: string;
  bucket: string;
  objectKey: string;
  tombstonedAt: Date;
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
  deletedAt: Date
): QuestV2ImageCleanupManifest => ({
  images,
  deletedAt: deletedAt.toISOString(),
});

const fromQuestV2ImageCleanupManifest = (
  resultData: unknown
): QuestV2ImageCleanupManifest | undefined => {
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) {
    return undefined;
  }

  const result = resultData as { cleanup?: unknown };
  if (!result.cleanup || typeof result.cleanup !== 'object' || Array.isArray(result.cleanup)) {
    return undefined;
  }

  const manifest = result.cleanup as Partial<QuestV2ImageCleanupManifest>;
  const deletedAt =
    typeof manifest.deletedAt === 'string' ? new Date(manifest.deletedAt) : undefined;
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

export const recordQuestV2ImageCleanupTombstones = async (
  userId: string,
  images: StoredQuestImage[],
  deletedAt = new Date()
): Promise<void> => {
  if (images.length === 0) return;

  await db
    .insert(file)
    .values(
      images.map((image) => ({
        ...image,
        uploadedByUserId: userId,
        deletedAt,
      }))
    )
    .onConflictDoNothing();
};

export const recordQuestV2ImageCleanupRetry = async (
  context: QuestV2ImageCommandContext,
  images: StoredQuestImage[],
  deletedAt: Date
): Promise<void> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext || images.length === 0) return;

  try {
    const parked = await parkQuestCommandPayload({
      executor: db,
      identity: {
        principalUserId: normalizedContext.userId,
        operationScope: questV2ImageUploadOperationScope,
        key: normalizedContext.key,
        requestHash: normalizedContext.requestHash,
        questId: normalizedContext.questId,
      },
      payload: { cleanup: toQuestV2ImageCleanupManifest(images, deletedAt) },
      now: deletedAt,
    });
    if (!parked) {
      throw new Error('Quest Image upload command was not available for cleanup retry');
    }
  } catch (cause) {
    throw new QuestV2ImageCleanupUnavailableError(cause);
  }
};

export const retryQuestV2ImageCleanupManifests = async (limit = 100): Promise<number> => {
  const pending = await findOpenQuestCommandPayloads({
    executor: db,
    operationScope: questV2ImageUploadOperationScope,
    limit,
  });

  let retried = 0;
  for (const record of pending) {
    const manifest = fromQuestV2ImageCleanupManifest(record.payload);
    if (!manifest) continue;

    try {
      await recordQuestV2ImageCleanupTombstones(
        record.principalUserId,
        manifest.images,
        new Date(manifest.deletedAt)
      );
      const completed = await completeQuestCommand({
        executor: db,
        id: record.id,
        payload: { kind: 'rejected', rejection: 'idempotency-unavailable' },
        now: new Date(),
      });
      if (completed) retried += 1;
    } catch (error) {
      console.error('[quest-image-cleanup] Cleanup tombstone retry failed', {
        error,
        commandId: record.id,
      });
    }
  }

  return retried;
};

const deleteQuestV2ImageUploadObject = async (
  object: QuestV2ImageUploadObject
): Promise<boolean> => {
  try {
    await questV2Storage.delete(object.bucket, object.objectKey);
    return true;
  } catch (error) {
    console.error('[quest-image-upload-recovery] Object deletion failed', {
      bucket: object.bucket,
      error,
      objectKey: object.objectKey,
    });
    return false;
  }
};

export const recoverQuestV2ImageUploadManifests = async (
  now = new Date(),
  limit = 100
): Promise<number> => {
  const pending = await db
    .select({
      id: questCommand.id,
      resultData: questCommand.resultData,
    })
    .from(questCommand)
    .where(
      and(
        eq(questCommand.operationScope, questV2ImageUploadOperationScope),
        eq(questCommand.processingStatus, 'PROCESSING'),
        lte(questCommand.expiresAt, now),
        sql`${questCommand.resultData} IS NOT NULL`
      )
    )
    .orderBy(asc(questCommand.expiresAt), asc(questCommand.id))
    .limit(limit);

  let recovered = 0;
  for (const record of pending) {
    const manifest = fromQuestV2ImageUploadManifest(record.resultData);
    if (!manifest) continue;

    const deleted = await Promise.all(
      manifest.upload.objects.map((object) => deleteQuestV2ImageUploadObject(object))
    );
    if (deleted.some((result) => !result)) continue;

    try {
      const completed = await completeQuestCommand({
        executor: db,
        id: record.id,
        payload: { kind: 'rejected', rejection: 'idempotency-unavailable' },
        now,
      });
      if (completed) recovered += 1;
    } catch (error) {
      console.error('[quest-image-upload-recovery] Quest Command completion failed', {
        error,
        commandId: record.id,
      });
    }
  }

  return recovered;
};

const cleanupQuestV2ImageObject = async (tombstone: QuestV2ImageTombstone): Promise<boolean> => {
  try {
    await questV2Storage.delete(tombstone.bucket, tombstone.objectKey);
    await db
      .update(file)
      .set({ objectDeletedAt: new Date() })
      .where(
        and(
          eq(file.id, tombstone.fileId),
          isNull(file.objectDeletedAt),
          eq(file.deletedAt, tombstone.tombstonedAt)
        )
      );
    return true;
  } catch (error) {
    console.error('[quest-image-cleanup] Object deletion failed', {
      bucket: tombstone.bucket,
      error,
      fileId: tombstone.fileId,
      objectKey: tombstone.objectKey,
      tombstonedAt: tombstone.tombstonedAt,
    });
    return false;
  }
};

export const cleanupQuestV2ImageObjects = async (
  now = new Date(),
  limit = 100
): Promise<number> => {
  const pending = await db
    .select({
      fileId: file.id,
      bucket: file.bucket,
      objectKey: file.objectKey,
      tombstonedAt: file.deletedAt,
    })
    .from(file)
    .where(
      and(
        like(file.objectKey, 'quests/v2/%'),
        sql`${file.deletedAt} IS NOT NULL`,
        isNull(file.objectDeletedAt),
        lte(file.deletedAt, now)
      )
    )
    .orderBy(asc(file.deletedAt), asc(file.id))
    .limit(limit)
    .then((objects): QuestV2ImageTombstone[] =>
      objects.filter((object): object is QuestV2ImageTombstone => object.tombstonedAt !== null)
    );

  const results = await Promise.all(pending.map((object) => cleanupQuestV2ImageObject(object)));
  return results.filter(Boolean).length;
};

type QuestV2ImageRemoveCommandResult = {
  images: QuestV2ImageReference[];
  response: QuestV2ImageResponse[];
  cleanup?: QuestV2ImageTombstone;
};

const deleteQuestV2ImageInTransaction = async (
  transaction: QuestTransaction,
  context: QuestV2ImageCommandContext,
  imageId: string,
  now: Date
): Promise<QuestV2ImageRemoveOutcome> => {
  // Lock before runQuestCommand: the Quest Command foreign key insert takes
  // FOR KEY SHARE on the Quest row.
  const ownedQuest = await lockQuestV2ImageOwner(transaction, context);
  if (!ownedQuest) return { outcome: 'not-found' };

  const command = await runQuestCommand({
    transaction,
    identity: {
      principalUserId: context.userId,
      operationScope: questV2ImageRemoveOperationScope,
      key: context.key,
      requestHash: context.requestHash,
      questId: context.questId,
    },
    now,
    work: async (): Promise<
      QuestCommandWork<QuestV2ImageRemoveCommandResult, 'not-found' | 'not-draft'>
    > => {
      if (ownedQuest.questStatus !== questStatus.draft) {
        return { kind: 'rejected', rejection: 'not-draft' };
      }

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
      if (!image) return { kind: 'rejected', rejection: 'not-found' };

      await softDeleteQuestImageAndRepack(transaction, {
        questId: context.questId,
        questImageId: image.imageId,
        fileId: image.fileId,
        deletedAt: now,
        positionOffset: maxQuestV2Images,
      });

      const images = await selectQuestV2Images(transaction, context.questId);
      const response = materializeQuestV2ImageResponse(images);
      return {
        kind: 'success',
        result: {
          images,
          response,
          cleanup: {
            fileId: image.fileId,
            bucket: image.bucket,
            objectKey: image.objectKey,
            tombstonedAt: now,
          },
        },
        resourceType: 'quest-image',
        resourceId: image.imageId,
      };
    },
    toSnapshot: ({ images, response }) => toQuestV2ImageIdempotencySnapshot(images, response),
    fromSnapshot: (snapshot) => {
      const result = fromQuestV2ImageIdempotencySnapshot(snapshot);
      return result ? { images: result.images, response: result.response } : undefined;
    },
  });

  if ('outcome' in command) return { outcome: command.outcome };
  if (command.kind === 'success') {
    if (command.result.cleanup) await cleanupQuestV2ImageObject(command.result.cleanup);
    return { images: command.result.images, response: command.result.response };
  }
  return { outcome: command.rejection };
};

export const deleteQuestV2Image = async (
  context: QuestV2ImageCommandContext,
  imageId: string
): Promise<QuestV2ImageRemoveOutcome> => {
  const normalizedContext = normalizeQuestV2ImageCommandContext(context);
  if (!normalizedContext) return { outcome: 'invalid-idempotency-key' };

  const now = new Date();
  return db.transaction((transaction) =>
    deleteQuestV2ImageInTransaction(transaction, normalizedContext, imageId, now)
  );
};

type QuestV2IdempotencySnapshot = Omit<QuestV2CanonicalQuest, 'questFundingTotal'> & {
  questFundingTotalSatang: Satang;
};

const normalizeQuestV2SnapshotScheduleTime = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;

  return formatQuestV2ScheduleTime(parsed);
};

const toQuestV2IdempotencySnapshot = (
  canonicalQuest: QuestV2CanonicalQuest
): QuestV2IdempotencySnapshot => {
  const questFundingTotalSatang = parseQuestFundingTotalSatang(canonicalQuest.questFundingTotal);
  if (!questFundingTotalSatang) {
    throw new Error(`Quest ${canonicalQuest.id} has an invalid Quest Funding Total`);
  }

  const { questFundingTotal: _questFundingTotal, ...canonicalFields } = canonicalQuest;
  return { ...canonicalFields, questFundingTotalSatang };
};

const fromQuestV2IdempotencySnapshot = (resultData: unknown): QuestV2CanonicalQuest | undefined => {
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

  const startTime = normalizeQuestV2SnapshotScheduleTime(snapshot.startTime);
  const dueAt =
    snapshot.dueAt === null ? null : normalizeQuestV2SnapshotScheduleTime(snapshot.dueAt);
  if (!startTime || (snapshot.dueAt !== null && !dueAt)) return undefined;

  const { questFundingTotalSatang: _questFundingTotalSatang, ...canonicalFields } = snapshot;
  return {
    ...canonicalFields,
    startTime,
    dueAt,
    questFundingTotal: toBaht(satang(questFundingTotalSatang)),
  } as QuestV2CanonicalQuest;
};

const toQuestV2QuestEscrowSnapshot = (
  reservationId: string,
  check: QuestV2PublishCheck
): QuestV2QuestEscrowSnapshot => ({
  reservationId,
  questFundingTotal: toBaht(check.questFundingTotalSatang),
  questFundingTotalSatang: check.questFundingTotalSatang,
  questReward: toBaht(check.questRewardSatang),
  questRewardSatang: check.questRewardSatang,
  platformFee: toBaht(check.platformFeeSatang),
  platformFeeSatang: check.platformFeeSatang,
  escrowRequirement: toBaht(check.escrowRequirementSatang),
  escrowRequirementSatang: check.escrowRequirementSatang,
  headcount: check.headcount,
  platformFeeBps: check.platformFeeBps,
  feeRoundingMode: check.feeRoundingMode,
  policyRevisionId: check.policyRevisionId,
  policyRevision: check.policyRevision,
});

type QuestV2QuestEscrowIdempotencySnapshot = Omit<
  QuestV2QuestEscrowSnapshot,
  'questFundingTotal' | 'questReward' | 'platformFee' | 'escrowRequirement'
>;

type QuestV2PublishIdempotencySnapshot = {
  quest: QuestV2IdempotencySnapshot;
  questEscrow: QuestV2QuestEscrowIdempotencySnapshot;
};

const toQuestV2PublishIdempotencySnapshot = (
  result: QuestV2PublishResponse
): QuestV2PublishIdempotencySnapshot => ({
  quest: toQuestV2IdempotencySnapshot(result.quest),
  questEscrow: {
    reservationId: result.questEscrow.reservationId,
    questFundingTotalSatang: result.questEscrow.questFundingTotalSatang,
    questRewardSatang: result.questEscrow.questRewardSatang,
    platformFeeSatang: result.questEscrow.platformFeeSatang,
    escrowRequirementSatang: result.questEscrow.escrowRequirementSatang,
    headcount: result.questEscrow.headcount,
    platformFeeBps: result.questEscrow.platformFeeBps,
    feeRoundingMode: result.questEscrow.feeRoundingMode,
    policyRevisionId: result.questEscrow.policyRevisionId,
    policyRevision: result.questEscrow.policyRevision,
  },
});

const fromQuestV2QuestEscrowIdempotencySnapshot = (
  value: unknown
): QuestV2QuestEscrowSnapshot | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const snapshot = value as Partial<QuestV2QuestEscrowIdempotencySnapshot>;
  const satangFields: unknown[] = [
    snapshot.questFundingTotalSatang,
    snapshot.questRewardSatang,
    snapshot.platformFeeSatang,
    snapshot.escrowRequirementSatang,
  ];
  if (
    typeof snapshot.reservationId !== 'string' ||
    typeof snapshot.policyRevisionId !== 'string' ||
    snapshot.feeRoundingMode !== 'UP' ||
    !satangFields.every((amount) => typeof amount === 'number' && Number.isInteger(amount)) ||
    typeof snapshot.headcount !== 'number' ||
    !Number.isInteger(snapshot.headcount) ||
    typeof snapshot.platformFeeBps !== 'number' ||
    !Number.isInteger(snapshot.platformFeeBps) ||
    typeof snapshot.policyRevision !== 'number' ||
    !Number.isInteger(snapshot.policyRevision)
  ) {
    return undefined;
  }

  const [questFundingTotalSatang, questRewardSatang, platformFeeSatang, escrowRequirementSatang] =
    satangFields as [number, number, number, number];
  if (
    questFundingTotalSatang < 100 ||
    questFundingTotalSatang > 70_000_000 ||
    questRewardSatang < 0 ||
    platformFeeSatang < 0 ||
    escrowRequirementSatang < 1 ||
    escrowRequirementSatang > 2_000_000_000 ||
    snapshot.headcount < 1 ||
    snapshot.headcount > 20 ||
    snapshot.platformFeeBps < 0 ||
    snapshot.platformFeeBps > 10_000 ||
    snapshot.policyRevision < 1
  ) {
    return undefined;
  }

  try {
    const total = satang(questFundingTotalSatang);
    const reward = satang(questRewardSatang);
    const fee = satang(platformFeeSatang);
    const escrow = satang(escrowRequirementSatang);

    return {
      reservationId: snapshot.reservationId,
      questFundingTotal: toBaht(total),
      questFundingTotalSatang: total,
      questReward: toBaht(reward),
      questRewardSatang: reward,
      platformFee: toBaht(fee),
      platformFeeSatang: fee,
      escrowRequirement: toBaht(escrow),
      escrowRequirementSatang: escrow,
      headcount: snapshot.headcount,
      platformFeeBps: snapshot.platformFeeBps,
      feeRoundingMode: snapshot.feeRoundingMode,
      policyRevisionId: snapshot.policyRevisionId,
      policyRevision: snapshot.policyRevision,
    };
  } catch {
    return undefined;
  }
};

const fromQuestV2PublishIdempotencySnapshot = (
  resultData: unknown
): QuestV2PublishResponse | undefined => {
  if (!resultData || typeof resultData !== 'object' || Array.isArray(resultData)) {
    return undefined;
  }

  const snapshot = resultData as Partial<QuestV2PublishIdempotencySnapshot>;
  const canonicalQuest = fromQuestV2IdempotencySnapshot(snapshot.quest);
  const questEscrow = fromQuestV2QuestEscrowIdempotencySnapshot(snapshot.questEscrow);
  if (!canonicalQuest || !questEscrow) return undefined;

  return { quest: canonicalQuest, questEscrow };
};

const lockQuestV2CommandQuest = async (transaction: QuestTransaction, questId: string) => {
  const [current] = await transaction
    .select({ id: quest.id, hirerId: quest.hirerId, questStatus: quest.questStatus })
    .from(quest)
    .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
    .limit(1)
    .for('update');
  return current;
};

type QuestV2PublishRejection =
  | { outcome: 'blocked'; check: QuestV2PublishCheck }
  | { outcome: 'not-draft' }
  | { outcome: 'not-found' };

const publishQuestV2InTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  rawIdempotencyKey: string,
  requestHash: string,
  now: Date
): Promise<QuestV2PublishOutcome | undefined> => {
  // Lock before runQuestCommand: the Quest Command foreign key insert takes
  // FOR KEY SHARE on the Quest row.
  const current = await lockQuestV2CommandQuest(transaction, questId);
  if (!current) return undefined;

  const command = await runQuestCommand({
    transaction,
    identity: {
      principalUserId: userId,
      operationScope: questV2PublishOperationScope,
      key: rawIdempotencyKey,
      requestHash,
      questId,
    },
    now,
    work: async (): Promise<QuestCommandWork<QuestV2PublishResponse, QuestV2PublishRejection>> => {
      if (current.hirerId !== userId)
        return { kind: 'rejected', rejection: { outcome: 'not-found' } };
      if (current.questStatus !== questStatus.draft) {
        return { kind: 'rejected', rejection: { outcome: 'not-draft' } };
      }

      const row = await selectQuestV2Row(transaction, userId, questId);
      if (!row) return { kind: 'rejected', rejection: { outcome: 'not-found' } };

      const check = await buildQuestV2PublishCheckForRow(transaction, userId, row, true);
      if (!check.canPublish) {
        return { kind: 'rejected', rejection: { outcome: 'blocked', check } };
      }

      const reservation = await reserveSpending(transaction, {
        ownerUserId: userId,
        callerScope: 'quest',
        callerReference: questId,
        amountSatang: check.escrowRequirementSatang,
      });
      if (reservation.policyRevisionId !== check.policyRevisionId) {
        throw new MoneyDomainError(
          'POLICY_NOT_AVAILABLE',
          'Money Policy changed while publishing the Quest.'
        );
      }

      const [updated] = await transaction
        .update(quest)
        .set({
          questStatus: questStatus.open,
          rewardSatang: check.questRewardSatang,
          questFundingTotalSatang: check.questFundingTotalSatang,
          headcount: check.headcount,
          fundingReservationId: reservation.id,
          policyRevisionId: check.policyRevisionId,
          platformFeeBps: check.platformFeeBps,
          platformFeePerWorkerSatang: check.platformFeeSatang,
          questEscrowSatang: check.escrowRequirementSatang,
          version: sql`${quest.version} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(quest.id, questId),
            eq(quest.hirerId, userId),
            eq(quest.apiVersion, questApiVersion.v2),
            eq(quest.questStatus, questStatus.draft)
          )
        )
        .returning({ id: quest.id });
      if (!updated) return { kind: 'rejected', rejection: { outcome: 'not-draft' } };

      const updatedRow = await selectQuestV2Row(transaction, userId, questId);
      if (!updatedRow) throw new Error(`Published Quest ${questId} could not be read back`);

      return {
        kind: 'success',
        result: {
          quest: await buildCanonicalQuest(transaction, updatedRow),
          questEscrow: toQuestV2QuestEscrowSnapshot(reservation.id, check),
        },
        resourceType: 'quest',
        resourceId: questId,
      };
    },
    toSnapshot: toQuestV2PublishIdempotencySnapshot,
    fromSnapshot: fromQuestV2PublishIdempotencySnapshot,
  });

  if ('outcome' in command) return { outcome: command.outcome };
  if (command.kind === 'success') return command.result;
  return command.rejection.outcome === 'not-found' ? undefined : command.rejection;
};

type QuestV2CreateBusinessOutcomeCode = Exclude<
  QuestV2CreateValidationOutcome,
  QuestCommandOutcomeCode
>;

const createQuestInTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  input: NormalizedCreateInput,
  requestHash: string,
  rawIdempotencyKey: string,
  now: Date
): Promise<QuestV2CreateOutcome> => {
  const command = await runQuestCommand({
    transaction,
    identity: {
      principalUserId: userId,
      operationScope: questV2CreateOperationScope,
      key: rawIdempotencyKey,
      requestHash,
    },
    now,
    work: async (): Promise<
      QuestCommandWork<QuestV2CanonicalQuest, QuestV2CreateBusinessOutcomeCode>
    > => {
      if (input.tagId) {
        const [existingTag] = await transaction
          .select({ id: tag.id })
          .from(tag)
          .where(eq(tag.id, input.tagId))
          .limit(1);
        if (!existingTag) return { kind: 'rejected', rejection: 'tag-not-found' };
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
      if (!createdQuest) throw new Error('Quest insert returned no row');

      await transaction.insert(questConditionItem).values(
        input.conditionItems.map((text, position) => ({
          questId: createdQuest.id,
          position,
          text,
        }))
      );

      if (input.locations.length > 0) {
        await transaction.insert(questLocation).values(
          input.locations.map((location) => ({
            questId: createdQuest.id,
            label: location.label,
          }))
        );
      }

      const createdRow = await selectQuestV2Row(transaction, userId, createdQuest.id);
      if (!createdRow) throw new Error(`Created Quest ${createdQuest.id} could not be read back`);
      const canonicalQuest = await buildCanonicalQuest(transaction, createdRow);

      return {
        kind: 'success',
        result: canonicalQuest,
        resourceType: 'quest',
        resourceId: createdQuest.id,
      };
    },
    toSnapshot: toQuestV2IdempotencySnapshot,
    fromSnapshot: fromQuestV2IdempotencySnapshot,
  });

  if ('outcome' in command) return { outcome: command.outcome };
  if (command.kind === 'success') return { quest: command.result };
  return { outcome: command.rejection };
};

export const createQuestV2 = async (
  userId: string,
  data: QuestV2CreateInput,
  rawIdempotencyKey: string
): Promise<QuestV2CreateOutcome> => {
  const input = normalizeCreateInput(data);
  if ('outcome' in input) return input;

  const requestHash = await requestHashFor(userId, input);
  const now = new Date();
  return db.transaction((transaction) =>
    createQuestInTransaction(transaction, userId, input, requestHash, rawIdempotencyKey, now)
  );
};

type QuestV2EditBusinessOutcomeCode = Exclude<QuestV2EditOutcomeCode, QuestCommandOutcomeCode>;

const editQuestV2InTransaction = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  expectedVersion: number,
  input: NormalizedEditInput,
  requestHash: string,
  rawIdempotencyKey: string,
  now: Date
): Promise<QuestV2EditOutcome> => {
  // Lock before runQuestCommand: the Quest Command foreign key insert takes
  // FOR KEY SHARE on the Quest row.
  const lockedQuest = await lockQuestV2CommandQuest(transaction, questId);
  if (!lockedQuest) return { outcome: 'not-found' };

  const command = await runQuestCommand({
    transaction,
    identity: {
      principalUserId: userId,
      operationScope: questV2EditOperationScope,
      key: rawIdempotencyKey,
      requestHash,
      questId,
    },
    now,
    work: async (): Promise<
      QuestCommandWork<QuestV2CanonicalQuest, QuestV2EditBusinessOutcomeCode>
    > => {
      if (lockedQuest.hirerId !== userId) return { kind: 'rejected', rejection: 'not-found' };

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
        .where(and(eq(quest.id, questId), eq(quest.apiVersion, questApiVersion.v2)))
        .limit(1);

      if (!current) return { kind: 'rejected', rejection: 'not-found' };
      if (current.questStatus !== questStatus.draft) {
        return { kind: 'rejected', rejection: 'not-draft' };
      }
      if (current.version !== expectedVersion) {
        return { kind: 'rejected', rejection: 'conflict' };
      }
      if (!current.v2Mode || !current.v2Participation) {
        throw new Error(`Quest ${questId} has incomplete v2 persistence data`);
      }

      const nextParticipation = input.participation ?? current.v2Participation;
      const nextHeadcount = input.headcount ?? current.headcount;
      if (!isValidQuestV2Headcount(nextParticipation, nextHeadcount)) {
        return { kind: 'rejected', rejection: 'invalid-headcount' };
      }

      const nextStartTime = input.startTime ?? current.startTime;
      const nextDueAt = input.dueAt === undefined ? current.dueAt : input.dueAt;
      if (nextDueAt !== null && nextDueAt <= nextStartTime) {
        return { kind: 'rejected', rejection: 'invalid-dates' };
      }

      if (input.tagId) {
        const [existingTag] = await transaction
          .select({ id: tag.id })
          .from(tag)
          .where(eq(tag.id, input.tagId))
          .limit(1);
        if (!existingTag) return { kind: 'rejected', rejection: 'tag-not-found' };
      }

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
        await transaction
          .insert(questConditionItem)
          .values(input.conditionItems.map((text, position) => ({ questId, position, text })));
      }

      if (input.locations !== undefined) {
        await transaction.delete(questLocation).where(eq(questLocation.questId, questId));
        if (input.locations.length > 0) {
          await transaction
            .insert(questLocation)
            .values(input.locations.map((location) => ({ questId, label: location.label })));
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
            eq(quest.version, expectedVersion)
          )
        )
        .returning({ id: quest.id });
      if (!updated) return { kind: 'rejected', rejection: 'conflict' };

      const updatedRow = await selectQuestV2Row(transaction, userId, questId);
      if (!updatedRow) throw new Error(`Updated Quest ${questId} could not be read back`);
      return {
        kind: 'success',
        result: await buildCanonicalQuest(transaction, updatedRow),
        resourceType: 'quest',
        resourceId: questId,
      };
    },
    toSnapshot: toQuestV2IdempotencySnapshot,
    fromSnapshot: fromQuestV2IdempotencySnapshot,
  });

  if ('outcome' in command) return { outcome: command.outcome };
  if (command.kind === 'success') return { quest: command.result };
  return { outcome: command.rejection };
};

export const editQuestV2 = async (
  userId: string,
  questId: string,
  data: QuestV2EditInput,
  expectedVersion: number,
  rawIdempotencyKey: string
): Promise<QuestV2EditOutcome> => {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { outcome: 'invalid-version' };
  }

  const input = normalizeEditInput(data);
  if ('outcome' in input) return input;

  const requestHash = await editRequestHashFor(userId, questId, expectedVersion, input);
  const now = new Date();
  return db.transaction((transaction) =>
    editQuestV2InTransaction(
      transaction,
      userId,
      questId,
      expectedVersion,
      input,
      requestHash,
      rawIdempotencyKey,
      now
    )
  );
};

const publishRequestHashFor = (userId: string, questId: string): Promise<string> =>
  sha256Json({
    authenticatedMemberId: userId,
    operation: questV2PublishOperationScope,
    path: questV2PublishPath,
    questId,
    body: null,
  });

export const publishQuestV2 = async (
  userId: string,
  questId: string,
  rawIdempotencyKey: string
): Promise<QuestV2PublishOutcome | undefined> => {
  const requestHash = await publishRequestHashFor(userId, questId);
  const now = new Date();
  return db.transaction((transaction) =>
    publishQuestV2InTransaction(transaction, userId, questId, rawIdempotencyKey, requestHash, now)
  );
};

const activeWorkerCountExpression = sql<number>`(
  SELECT COUNT(*)::int
  FROM ${questAssignment}
  WHERE ${questAssignment.questId} = ${quest.id}
    AND ${questAssignment.assignmentStatus} = ${assignmentStatus.active}
)`;

const questV2PublicReadConditions = (userId: string) => [
  eq(quest.apiVersion, questApiVersion.v2),
  and(eq(quest.questStatus, questStatus.open), isNull(quest.hiddenAt)),
  ne(quest.hirerId, userId),
  isNotNull(quest.rewardSatang),
  isNotNull(quest.v2Mode),
  isNotNull(quest.v2Participation),
  isNotNull(quest.dueAt),
  isNotNull(tag.id),
];

const parseBahtFilterSatang = (value: number): Satang => {
  const [bahtPart, satangPart] = value.toString().split('.');
  return satang(Number(`${bahtPart}${(satangPart ?? '').padEnd(2, '0')}`));
};

const boardCursorCondition = (cursor: ReturnType<typeof decodeCursor>) => {
  if (!cursor) return undefined;

  const startTime = new Date(cursor.startTime);
  return or(
    gt(quest.startTime, startTime),
    and(eq(quest.startTime, startTime), gt(quest.id, cursor.id))
  );
};

const firstLocationLabels = async (questIds: string[]) => {
  if (questIds.length === 0) return new Map<string, string | null>();

  const rows = await db
    .select({ questId: questLocation.questId, label: questLocation.label })
    .from(questLocation)
    .where(inArray(questLocation.questId, questIds))
    .orderBy(asc(questLocation.id));
  const labels = new Map<string, string | null>();

  for (const row of rows) {
    if (!labels.has(row.questId)) labels.set(row.questId, row.label?.trim() || null);
  }

  return labels;
};

const toQuestV2BoardCard = (
  row: QuestV2BoardRow,
  locations: Map<string, string | null>
): QuestV2BoardCard => {
  if (!isCompleteQuestV2DiscoveryRow(row)) {
    throw new Error(`Quest ${row.id} has incomplete v2 Board data`);
  }

  return {
    id: row.id,
    title: row.title,
    questReward: toBaht(satang(row.rewardSatang)),
    tag: { id: row.tagId, name: row.tagName },
    mode: row.v2Mode,
    participation: row.v2Participation,
    headcount: row.headcount,
    activeWorkerCount: Number(row.activeWorkerCount),
    startTime: formatQuestV2ScheduleTime(row.startTime),
    dueAt: formatQuestV2ScheduleTime(row.dueAt),
    hirerName: `${row.hirerFirstName} ${row.hirerLastName}`.trim(),
    location: locations.get(row.id) ?? null,
  };
};

export const listQuestBoardV2 = async (
  userId: string,
  filters: QuestV2BoardQuery
): Promise<{ items: QuestV2BoardCard[]; nextCursor: string | null }> => {
  const limit = parsePageLimit(filters.limit);
  const cursor = decodeCursor(filters.cursor);
  const conditions = [
    ...questV2PublicReadConditions(userId),
    gt(quest.startTime, new Date()),
    or(
      eq(quest.v2Mode, 'CANDIDATE'),
      and(
        eq(quest.v2Mode, 'FIRST_COME_FIRST_SERVED'),
        or(
          and(eq(quest.v2Participation, 'SINGLE'), sql`${activeWorkerCountExpression} = 0`),
          and(
            eq(quest.v2Participation, 'GROUP'),
            sql`${activeWorkerCountExpression} < ${quest.headcount}`
          )
        )
      )
    ),
  ];

  const queryText = filters.q?.trim();
  if (queryText) {
    const pattern = `%${queryText.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(
      sql`(${quest.title} ILIKE ${pattern} ESCAPE ${'\\'} OR ${quest.description} ILIKE ${pattern} ESCAPE ${'\\'})`
    );
  }
  if (filters.tagId) conditions.push(eq(quest.tagId, filters.tagId));
  if (filters.mode) conditions.push(eq(quest.v2Mode, filters.mode));
  if (filters.participation) conditions.push(eq(quest.v2Participation, filters.participation));
  if (filters.minQuestReward !== undefined) {
    conditions.push(sql`${quest.rewardSatang} >= ${parseBahtFilterSatang(filters.minQuestReward)}`);
  }
  if (filters.maxQuestReward !== undefined) {
    conditions.push(sql`${quest.rewardSatang} <= ${parseBahtFilterSatang(filters.maxQuestReward)}`);
  }
  if (filters.maxDurationMinutes !== undefined) {
    conditions.push(
      sql`${quest.dueAt} IS NOT NULL AND EXTRACT(EPOCH FROM (${quest.dueAt} - ${quest.startTime})) / 60 <= ${filters.maxDurationMinutes}`
    );
  }
  if (filters.startFrom) conditions.push(gte(quest.startTime, new Date(filters.startFrom)));
  if (filters.startTo) conditions.push(lte(quest.startTime, new Date(filters.startTo)));

  const cursorCondition = boardCursorCondition(cursor);
  if (cursorCondition) conditions.push(cursorCondition);

  const rows = (await db
    .select({
      id: quest.id,
      title: quest.title,
      rewardSatang: quest.rewardSatang,
      tagId: tag.id,
      tagName: tag.name,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      headcount: quest.headcount,
      activeWorkerCount: activeWorkerCountExpression,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
      hirerFirstName: authUser.firstName,
      hirerLastName: authUser.lastName,
    })
    .from(quest)
    .innerJoin(authUser, eq(quest.hirerId, authUser.id))
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(and(...conditions))
    .orderBy(asc(quest.startTime), asc(quest.id))
    .limit(limit + 1)) as QuestV2BoardRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const locations = await firstLocationLabels(page.map((row) => row.id));
  const items = page.map((row) => toQuestV2BoardCard(row, locations));
  const last = page[page.length - 1];

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ id: last.id, startTime: last.startTime.toISOString() })
        : null,
  };
};

export const materializeQuestV2PublicImageResponse = (
  images: QuestV2ImageReference[]
): QuestV2PublicImageResponse[] =>
  images.map((image) => {
    const link = questV2Storage.linkForWithExpiry(image);
    return {
      imageId: image.imageId,
      position: image.position,
      url: link.url,
      urlExpiresAt: link.expiresAt.toISOString(),
    };
  });

export const getPublicQuestV2Detail = async (
  userId: string,
  questId: string
): Promise<QuestV2PublicDetail | undefined> => {
  const [row] = await db
    .select({
      id: quest.id,
      title: quest.title,
      description: quest.description,
      rewardSatang: quest.rewardSatang,
      tagId: tag.id,
      tagName: tag.name,
      v2Mode: quest.v2Mode,
      v2Participation: quest.v2Participation,
      headcount: quest.headcount,
      questStatus: quest.questStatus,
      activeWorkerCount: activeWorkerCountExpression,
      startTime: quest.startTime,
      dueAt: quest.dueAt,
      proofRequired: quest.proofRequired,
      hirerFirstName: authUser.firstName,
      hirerLastName: authUser.lastName,
    })
    .from(quest)
    .innerJoin(authUser, eq(quest.hirerId, authUser.id))
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(and(eq(quest.id, questId), ...questV2PublicReadConditions(userId)))
    .limit(1);

  if (!row) return undefined;
  const publicRow = row as QuestV2PublicDetailRow;
  if (!isCompleteQuestV2DiscoveryRow(publicRow)) {
    throw new Error(`Quest ${questId} has incomplete v2 Public Detail data`);
  }

  const [conditionItems, locations, images] = await Promise.all([
    selectConditionItems(db, questId),
    selectLocations(db, questId),
    selectQuestV2Images(db, questId),
  ]);
  if (conditionItems.length === 0) throw new Error(`Quest ${questId} has no Condition Items`);

  return {
    id: publicRow.id,
    title: publicRow.title,
    description: publicRow.description,
    condition: { items: conditionItems },
    tag: { id: publicRow.tagId, name: publicRow.tagName },
    mode: publicRow.v2Mode,
    participation: publicRow.v2Participation,
    state: toV2State(publicRow.questStatus),
    questReward: toBaht(satang(publicRow.rewardSatang)),
    headcount: publicRow.headcount,
    activeWorkerCount: Number(publicRow.activeWorkerCount),
    startTime: formatQuestV2ScheduleTime(publicRow.startTime),
    dueAt: formatQuestV2ScheduleTime(publicRow.dueAt),
    proofRequired: publicRow.proofRequired,
    hirerName: `${publicRow.hirerFirstName} ${publicRow.hirerLastName}`.trim(),
    locations,
    images,
  };
};

export const listOwnQuestV2 = async (
  userId: string,
  filters: { limit?: number; cursor?: string }
) => {
  const limit = parsePageLimit(filters.limit);
  const cursor = decodeCursor(filters.cursor);
  const conditions = [eq(quest.apiVersion, questApiVersion.v2), eq(quest.hirerId, userId)];

  if (cursor) {
    const startTime = new Date(cursor.startTime);
    const cursorCondition = or(
      gt(quest.startTime, startTime),
      and(eq(quest.startTime, startTime), gt(quest.id, cursor.id))
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
  questId: string
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
  questId: string
): Promise<QuestV2PublishCheckOutcome | undefined> =>
  db.transaction(async (transaction) => {
    const row = await selectQuestV2Row(transaction, userId, questId);
    if (!row) return undefined;
    if (row.questStatus !== questStatus.draft) return { outcome: 'not-draft' };
    return buildQuestV2PublishCheckForRow(transaction, userId, row, false);
  });
