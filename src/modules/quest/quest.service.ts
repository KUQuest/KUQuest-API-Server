import { db } from '@/database/client';
import { authUser } from '@/database/schema/auth.schema';
import { quest, questImage, questLocation } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import {
  decodeCursor,
  encodeCursor,
  parsePageLimit,
  type CursorPayload,
} from '@/shared/cursor';

import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';

import {
  buildQuestPublishCheck,
  type QuestPublishCheck,
} from './quest.publish.policy';
import type { QuestCreateInput } from './quest.schema';

type QuestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type QuestPublishRow = {
  id: string;
  questStatus: string;
  tagId: string | null;
  rewardSatang: number;
  headcount: number;
  startTime: Date;
  dueAt: Date | null;
};

export type QuestPublishOutcome =
  | { outcome: 'published' }
  | { outcome: 'not-draft' }
  | { outcome: 'blocked'; check: QuestPublishCheck };

type QuestRow = {
  id: string;
  title: string;
  description: string | null;
  condition: string;
  rewardSatang: number;
  tagId: string | null;
  tagName: string | null;
  mode: 'FIRST_COME_FIRST_SERVED' | 'CANDIDATE';
  participation: 'SINGLE' | 'GROUP';
  questStatus: string;
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
  address: string | null;
  latitude: string;
  longitude: string;
  position: number;
};

export type QuestListFilters = {
  q?: string;
  tagId?: string;
  mode?: 'FIRST_COME_FIRST_SERVED' | 'CANDIDATE';
  participation?: 'SINGLE' | 'GROUP';
  maxDurationMinutes?: number;
  minReward?: number;
  maxReward?: number;
  startFrom?: Date;
  startTo?: Date;
  latitude?: number;
  longitude?: number;
  limit?: number;
  cursor?: string;
};

export type QuestCreateOutcome =
  | { id: string }
  | { outcome: 'tag-not-found' | 'invalid-dates' | 'invalid-headcount' };

const toRewardBaht = (rewardSatang: number) => Math.trunc(rewardSatang / 100);

const durationMinutes = (startTime: Date, dueAt: Date | null) => {
  if (!dueAt) return null;

  return Math.max(1, Math.round((dueAt.getTime() - startTime.getTime()) / 60_000));
};

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

const hirerName = (row: Pick<QuestRow, 'hirerFirstName' | 'hirerLastName'>) =>
  `${row.hirerFirstName} ${row.hirerLastName}`.trim();

const toLocation = (location: LocationRow) => ({
  label: location.label,
  address: location.address,
  latitude: Number(location.latitude),
  longitude: Number(location.longitude),
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
    .select({
      questId: questLocation.questId,
      label: questLocation.label,
      address: questLocation.address,
      latitude: questLocation.lat,
      longitude: questLocation.lng,
      position: questLocation.position,
    })
    .from(questLocation)
    .where(inArray(questLocation.questId, questIds))
    .orderBy(asc(questLocation.position));

  return groupLocations(locations);
};

const haversineDistanceKm = (
  fromLatitude: number,
  fromLongitude: number,
  toLatitude: number,
  toLongitude: number,
) => {
  const earthRadiusKm = 6371;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(toLatitude - fromLatitude);
  const longitudeDelta = toRadians(toLongitude - fromLongitude);
  const latitudeA = toRadians(fromLatitude);
  const latitudeB = toRadians(toLatitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
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
    hirerId ? eq(quest.giverId, hirerId) : eq(quest.questStatus, 'OPEN'),
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
    .innerJoin(authUser, eq(quest.giverId, authUser.id))
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
  coordinates?: { latitude: number; longitude: number },
) => {
  const firstLocation = locations.get(row.id)?.[0];
  const location = firstLocation ? toLocation(firstLocation) : null;

  return {
    id: row.id,
    title: row.title,
    reward: toRewardBaht(row.rewardSatang),
    tag: row.tagId && row.tagName ? { id: row.tagId, name: row.tagName } : null,
    mode: row.mode,
    participation: row.participation,
    headcount: row.headcount,
    startTime: row.startTime.toISOString(),
    estimatedDurationMinutes: durationMinutes(row.startTime, row.dueAt),
    hirerName: hirerName(row),
    location,
    ...(coordinates
      ? {
          distanceKm: location
            ? haversineDistanceKm(
                coordinates.latitude,
                coordinates.longitude,
                location.latitude,
                location.longitude,
              )
            : null,
        }
      : {}),
  };
};

const serializeBoardCard = (
  row: QuestRow,
  locations: Map<string, LocationRow[]>,
  coordinates?: { latitude: number; longitude: number },
) => {
  const card = serializeCard(row, locations, coordinates);
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
  const coordinates =
    filters.latitude !== undefined && filters.longitude !== undefined
      ? { latitude: filters.latitude, longitude: filters.longitude }
      : undefined;
  const items = result.rows.map((row) => serializeBoardCard(row, result.locations, coordinates));

  return {
    items,
    nextCursor: nextCursorFor(result.rows, result.hasMore),
  };
};

export const createQuest = async (
  userId: string,
  data: QuestCreateInput,
): Promise<QuestCreateOutcome> => {
  if (data.participation === 'SINGLE' && data.headcount !== 1) {
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
        giverId: userId,
        title: data.title,
        description: data.description ?? null,
        condition: data.condition,
        mode: data.mode,
        participation: data.participation,
        questStatus: 'DRAFT',
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
        data.locations.map((location, index) => ({
          questId: created.id,
          label: location.label ?? null,
          address: location.address ?? null,
          lat: String(location.latitude),
          lng: String(location.longitude),
          position: index + 1,
        })),
      );
    }

    return { id: created.id };
  });
};

export const listOwnQuests = async (userId: string, filters: QuestListFilters) => {
  const result = await listRows(filters, userId);
  const coordinates =
    filters.latitude !== undefined && filters.longitude !== undefined
      ? { latitude: filters.latitude, longitude: filters.longitude }
      : undefined;
  const items = result.rows.map((row) => ({
    ...serializeCard(row, result.locations, coordinates),
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
    .innerJoin(authUser, eq(quest.giverId, authUser.id))
    .leftJoin(tag, eq(quest.tagId, tag.id))
    .where(
      and(
        eq(quest.id, questId),
        or(eq(quest.giverId, userId), eq(quest.questStatus, 'OPEN')),
      ),
    )
    .limit(1);

  if (!row) return undefined;

  const locations = await db
    .select({
      label: questLocation.label,
      address: questLocation.address,
      latitude: questLocation.lat,
      longitude: questLocation.lng,
      position: questLocation.position,
    })
    .from(questLocation)
    .where(eq(questLocation.questId, questId))
    .orderBy(asc(questLocation.position));

  const images = await db
    .select({ fileId: questImage.fileId })
    .from(questImage)
    .where(eq(questImage.questId, questId))
    .orderBy(asc(questImage.position));

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    condition: row.condition,
    reward: toRewardBaht(row.rewardSatang),
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
    locations: locations.map((location) => ({
      ...toLocation({ questId, ...location }),
      position: location.position,
    })),
    images,
  };
};

const selectPublishRow = async (
  transaction: QuestTransaction,
  userId: string,
  questId: string,
  lock: boolean,
) => {
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
    .where(and(eq(quest.id, questId), eq(quest.giverId, userId)))
    .limit(1);

  const rows = lock ? await query.for('update') : await query;
  return rows[0] as QuestPublishRow | undefined;
};

const buildPublishCheck = async (
  transaction: QuestTransaction,
  row: QuestPublishRow,
) => {
  const [imageRows] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questImage)
    .where(eq(questImage.questId, row.id));
  const [locationRows] = await transaction
    .select({ count: sql<number>`count(*)` })
    .from(questLocation)
    .where(eq(questLocation.questId, row.id));

  return buildQuestPublishCheck({
    tagId: row.tagId,
    startTime: row.startTime,
    dueAt: row.dueAt,
    hasImages: Number(imageRows?.count ?? 0) > 0,
    hasLocations: Number(locationRows?.count ?? 0) > 0,
    rewardSatang: row.rewardSatang,
    headcount: row.headcount,
    now: new Date(),
  });
};

export const getQuestPublishCheck = async (
  userId: string,
  questId: string,
): Promise<QuestPublishCheck | { outcome: 'not-draft' } | undefined> =>
  db.transaction(async (transaction) => {
    const row = await selectPublishRow(transaction, userId, questId, false);
    if (!row) return undefined;
    if (row.questStatus !== 'DRAFT') return { outcome: 'not-draft' };

    return buildPublishCheck(transaction, row);
  });

export const publishQuest = async (
  userId: string,
  questId: string,
): Promise<QuestPublishOutcome | undefined> =>
  db.transaction(async (transaction) => {
    const row = await selectPublishRow(transaction, userId, questId, true);
    if (!row) return undefined;
    if (row.questStatus !== 'DRAFT') return { outcome: 'not-draft' };

    const check = await buildPublishCheck(transaction, row);
    if (!check.canPublish) return { outcome: 'blocked', check };

    const [updated] = await transaction
      .update(quest)
      .set({ questStatus: 'OPEN', updatedAt: new Date() })
      .where(
        and(
          eq(quest.id, questId),
          eq(quest.giverId, userId),
          eq(quest.questStatus, 'DRAFT'),
        ),
      )
      .returning({ id: quest.id });

    return updated ? { outcome: 'published' } : { outcome: 'not-draft' };
  });
