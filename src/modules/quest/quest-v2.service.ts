import { db } from '@/database/client';
import { questConditionItem, quest, questApiVersion, questLocation } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { walletIdempotencyKey } from '@/database/schema/wallet.schema';
import { positiveSatang, satang, type Satang } from '@/modules/wallet';
import { decodeCursor, encodeCursor, parsePageLimit } from '@/shared/cursor';

import { and, asc, eq, gt, or } from 'drizzle-orm';

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
import type { QuestV2CreateInput } from './quest-v2.schema';

type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type QuestDatabase = typeof db | QuestTransaction;

export const questV2CreateOperationScope = 'quest.v2.create';

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
  locations: Array<{ label: string | null }>;
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

export type QuestV2CreateOutcome =
  | { quest: QuestV2CanonicalQuest }
  | {
      outcome:
        | QuestV2CreateValidationOutcome
        | 'idempotency-key-reused'
        | 'idempotency-in-progress';
    };

type QuestV2Row = {
  id: string;
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

  const valueInSatang = Number(bahtPart) * 100 + Number((satangPart ?? '').padEnd(2, '0'));
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
  const locations = (data.locations ?? []).map((location) => ({
    label: location.label === undefined || location.label === null ? null : location.label.trim(),
  }));
  if (
    locations.length > 10 ||
    locations.some(
      (location) => location.label !== null && (location.label.length === 0 || location.label.length > 100),
    )
  ) {
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

const requestHashFor = (input: NormalizedCreateInput): Promise<string> =>
  sha256Json({
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

const selectLocations = async (database: QuestDatabase, questId: string) =>
  database
    .select({ label: questLocation.label })
    .from(questLocation)
    .where(eq(questLocation.questId, questId))
    .orderBy(asc(questLocation.id));

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

type IdempotencyRecord = {
  id: string;
  requestHash: string;
  resourceId: string | null;
  processingStatus: string;
};

const acquireCreateIdempotency = async (
  transaction: QuestTransaction,
  userId: string,
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
      operationScope: questV2CreateOperationScope,
      key,
      requestHash,
      expiresAt: idempotencyExpiry(),
    })
    .onConflictDoNothing()
    .returning({
      id: walletIdempotencyKey.id,
      requestHash: walletIdempotencyKey.requestHash,
      resourceId: walletIdempotencyKey.resourceId,
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
            processingStatus: walletIdempotencyKey.processingStatus,
          })
          .from(walletIdempotencyKey)
          .where(
            and(
              eq(walletIdempotencyKey.principalUserId, userId),
              eq(walletIdempotencyKey.operationScope, questV2CreateOperationScope),
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
  const idempotency = await acquireCreateIdempotency(transaction, userId, key, requestHash);
  if ('outcome' in idempotency) return idempotency;

  if (!idempotency.created && idempotency.record.resourceId) {
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
      rewardSatang: input.questFundingTotalSatang,
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

  await transaction
    .update(walletIdempotencyKey)
    .set({
      resourceType: 'quest',
      resourceId: createdQuest.id,
      processingStatus: 'COMPLETED',
      completedAt: new Date(),
    })
    .where(eq(walletIdempotencyKey.id, idempotency.record.id));

  const createdRow = await selectQuestV2Row(transaction, userId, createdQuest.id);
  if (!createdRow) return { outcome: 'idempotency-unavailable' };

  return { quest: await buildCanonicalQuest(transaction, createdRow) };
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

  const requestHash = await requestHashFor(input);

  try {
    return await db.transaction((transaction) =>
      createQuestInTransaction(transaction, userId, key, input, requestHash),
    );
  } catch (error) {
    if (error instanceof QuestV2InputError) return { outcome: error.outcome };
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
