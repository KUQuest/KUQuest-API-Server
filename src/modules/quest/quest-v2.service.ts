import { db } from '@/database/client';
import {
  quest,
  questApiVersion,
  questConditionItem,
  questLocation,
} from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { positiveSatang, satang, type Satang } from '@/modules/wallet';
import { decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import { and, asc, eq, gt, or, sql } from 'drizzle-orm';

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
import type { QuestV2CreateInput, QuestV2EditInput } from './quest-v2.schema';

type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuestDatabase = typeof db | QuestTransaction;

export const questV2CreateOperationScope = 'quest.v2.create';
export const questV2EditOperationScope = 'quest.v2.edit';
const questV2CreatePath = '/api/v2/quests';
const questV2EditPath = '/api/v2/quests/:questId';

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

const toBaht = (amount: Satang): number => Number((amount / 100).toFixed(2));

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
};

const acquireQuestV2Idempotency = async (
  transaction: QuestTransaction,
  userId: string,
  operationScope: string,
  key: string,
  requestHash: string,
): Promise<
  | { created: true; record: IdempotencyRecord }
  | { created: false; record: IdempotencyRecord }
  | { outcome: 'idempotency-key-reused' | 'idempotency-in-progress' | 'idempotency-unavailable' }
> => {
  const [created] = await transaction
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
    });

  const record = created
    ? created
    : (
        await transaction
          .select({
            id: walletIdempotencyKey.id,
            requestHash: walletIdempotencyKey.requestHash,
            resourceId: walletIdempotencyKey.resourceId,
            resultData: walletIdempotencyKey.resultData,
            processingStatus: walletIdempotencyKey.processingStatus,
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
): Promise<QuestV2CanonicalQuest | undefined> => {
  const row = await selectQuestV2Row(db, userId, questId);
  return row ? buildCanonicalQuest(db, row) : undefined;
};
