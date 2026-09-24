import { authUser } from '@/database/schema/auth.schema';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { db, sql } from '@/database/client';
import { seedQuestTags } from '@/modules/tag/tag.service';

import { randomUUID } from 'node:crypto';

import { asc, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'bun:test';

const expectedTagNames = [
  'ทำความสะอาด (Cleaning)',
  'ส่งของ (Delivery)',
  'ซ่อมแซม (Fixing)',
  'สอนหนังสือ (Teaching)',
  'กีฬา (Sport)',
  'เกมและสันทนาการ (Game/Activity)',
  'งานและการบ้าน (Work/Homework)',
  'อาหารและเครื่องดื่ม (Food and Drinks)',
  'สัตว์เลี้ยง (Pet)',
  'ออกแบบ (Design)',
  'ถ่ายภาพ (Photography)',
  'อื่นๆ (ETC.)',
];

beforeAll(async () => {
  try {
    await sql`select 1`;
  } catch (cause) {
    throw new Error(
      'These tests need PostgreSQL. Start it with `docker compose up -d postgres`, then apply the schema with `bun run db:migrate`.',
      { cause }
    );
  }
  await seedQuestTags();
});

describe('Tag seed', () => {
  it('contains the fixed vocabulary exactly once', async () => {
    const rows = await db
      .select({ name: tag.name })
      .from(tag)
      .where(inArray(tag.name, expectedTagNames))
      .orderBy(asc(tag.name));

    expect(rows.map(({ name }) => name).sort()).toEqual([...expectedTagNames].sort());
    expect(new Set(rows.map(({ name }) => name)).size).toBe(expectedTagNames.length);
  });

  it('remaps Quest Tag associations before removing old Tag rows', async () => {
    const hirerId = randomUUID();
    const migrationCases = [
      {
        legacyName: 'English Tutoring',
        targetName: 'สอนหนังสือ (Teaching)',
      },
      {
        legacyName: 'Event Photography & Videography',
        targetName: 'ถ่ายภาพ (Photography)',
      },
      {
        legacyName: 'Campus Errand & Delivery',
        targetName: 'ส่งของ (Delivery)',
      },
      {
        legacyName: 'Unrecognized Legacy Tag',
        targetName: 'อื่นๆ (ETC.)',
      },
    ].map((migration) => ({
      ...migration,
      questId: randomUUID(),
      tagId: randomUUID(),
    }));

    try {
      await db.insert(authUser).values({
        id: hirerId,
        email: `tag-seed-${hirerId}@ku.th`,
        firstName: 'Tag',
        lastName: 'Seed',
      });
      await db.insert(tag).values(
        migrationCases.map(({ tagId, legacyName }) => ({
          id: tagId,
          name: legacyName,
        }))
      );
      await db.insert(quest).values(
        migrationCases.map(({ questId, tagId }) => ({
          id: questId,
          hirerId,
          apiVersion: 'v2' as const,
          title: `Tag migration ${questId}`,
          condition: 'Complete the work',
          mode: 'NO_CANDIDATE' as const,
          participation: 'SOLO' as const,
          v2Mode: 'FIRST_COME_FIRST_SERVED' as const,
          v2Participation: 'SINGLE' as const,
          questStatus: 'QUEST_OPEN' as const,
          rewardSatang: 1000,
          questFundingTotalSatang: 2000,
          tagId,
          headcount: 1,
          startTime: new Date('2030-01-01T10:00:00.000Z'),
        }))
      );

      const result = await seedQuestTags();
      const rows = await db
        .select({ questId: quest.id, tagName: tag.name })
        .from(quest)
        .innerJoin(tag, eq(quest.tagId, tag.id))
        .where(
          inArray(
            quest.id,
            migrationCases.map(({ questId }) => questId)
          )
        );
      const migratedTags = rows
        .map(({ questId, tagName }) => ({ questId, tagName }))
        .sort((first, second) => first.questId.localeCompare(second.questId));
      const expectedMigrations = migrationCases
        .map(({ questId, targetName }) => ({ questId, tagName: targetName }))
        .sort((first, second) => first.questId.localeCompare(second.questId));
      const legacyTags = await db
        .select({ id: tag.id })
        .from(tag)
        .where(
          inArray(
            tag.id,
            migrationCases.map(({ tagId }) => tagId)
          )
        );

      expect(result).toEqual({ total: expectedTagNames.length, removed: migrationCases.length });
      expect(migratedTags).toEqual(expectedMigrations);
      expect(legacyTags).toEqual([]);
    } finally {
      await db.delete(quest).where(
        inArray(
          quest.id,
          migrationCases.map(({ questId }) => questId)
        )
      );
      await db.delete(authUser).where(eq(authUser.id, hirerId));
      await db.delete(tag).where(
        inArray(
          tag.id,
          migrationCases.map(({ tagId }) => tagId)
        )
      );
    }
  });

  it('runs idempotently', async () => {
    const result = await seedQuestTags();
    expect(result.total).toBe(expectedTagNames.length);
    expect(result.removed).toBe(0);
  });
});
