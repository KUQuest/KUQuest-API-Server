import { db } from '@/database/client';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { DEFAULT_PAGE_LIMIT } from '@/shared/cursor';
import { fixedTagNames, otherQuestTagName, type FixedTagName } from '@/shared/tag';

import { and, asc, eq, gt, ilike, inArray, or } from 'drizzle-orm';

import { decodeTagCursor, encodeTagCursor } from './tag.cursor';

export type Tag = {
  id: string;
  name: string;
};

export type TagSearchOptions = {
  q?: string;
  limit?: number;
  cursor?: string;
};

export type TagPage = {
  items: Tag[];
  nextCursor: string | null;
};

export const legacyTagMappings: Partial<Record<string, FixedTagName>> = {
  '3D Modeling & Animation': 'ออกแบบ (Design)',
  'Academic Writing': 'งานและการบ้าน (Work/Homework)',
  'Accounting & Bookkeeping': 'งานและการบ้าน (Work/Homework)',
  'Agricultural Field Work': otherQuestTagName,
  'Animal Care & Pet Sitting': 'สัตว์เลี้ยง (Pet)',
  'Audio Production & Music': 'ออกแบบ (Design)',
  'Backend Development': 'งานและการบ้าน (Work/Homework)',
  'Biology Tutoring': 'สอนหนังสือ (Teaching)',
  'Business Planning': 'งานและการบ้าน (Work/Homework)',
  'Campus Errand & Delivery': 'ส่งของ (Delivery)',
  'Campus Tour & Guiding': 'เกมและสันทนาการ (Game/Activity)',
  'Chemistry Tutoring': 'สอนหนังสือ (Teaching)',
  'Chinese Translation': 'งานและการบ้าน (Work/Homework)',
  'Computer Science Tutoring': 'สอนหนังสือ (Teaching)',
  Content: 'งานและการบ้าน (Work/Homework)',
  'Content Writing & Copywriting': 'งานและการบ้าน (Work/Homework)',
  Cybersecurity: 'งานและการบ้าน (Work/Homework)',
  'Data Analysis': 'งานและการบ้าน (Work/Homework)',
  'Data Entry & Transcription': 'งานและการบ้าน (Work/Homework)',
  'Data Visualization': 'งานและการบ้าน (Work/Homework)',
  'Database Management': 'งานและการบ้าน (Work/Homework)',
  'DevOps & Cloud Infrastructure': 'งานและการบ้าน (Work/Homework)',
  'Document Printing & Pickup': 'ส่งของ (Delivery)',
  'English Tutoring': 'สอนหนังสือ (Teaching)',
  'English-Thai Translation': 'งานและการบ้าน (Work/Homework)',
  'Event Photography & Videography': 'ถ่ายภาพ (Photography)',
  'Event Staff & Ushering': 'เกมและสันทนาการ (Game/Activity)',
  'Exam Preparation': 'สอนหนังสือ (Teaching)',
  'Food Science & Quality Testing': 'อาหารและเครื่องดื่ม (Food and Drinks)',
  Frontend: 'งานและการบ้าน (Work/Homework)',
  'Frontend Development': 'งานและการบ้าน (Work/Homework)',
  'Fullstack Development': 'งานและการบ้าน (Work/Homework)',
  'Game Development': 'งานและการบ้าน (Work/Homework)',
  'General Assistance': otherQuestTagName,
  Design: 'ออกแบบ (Design)',
  'Graphic Design': 'ออกแบบ (Design)',
  'Illustration & Digital Art': 'ออกแบบ (Design)',
  'Japanese Translation': 'งานและการบ้าน (Work/Homework)',
  'Logo & Branding Design': 'ออกแบบ (Design)',
  'MC & Public Speaking': 'เกมและสันทนาการ (Game/Activity)',
  'Machine Learning & AI': 'งานและการบ้าน (Work/Homework)',
  'Market Research': 'งานและการบ้าน (Work/Homework)',
  'Marketing Campaign': 'งานและการบ้าน (Work/Homework)',
  'Mathematics Tutoring': 'สอนหนังสือ (Teaching)',
  'Mobile App Development': 'งานและการบ้าน (Work/Homework)',
  'Motion Graphics': 'ออกแบบ (Design)',
  'Moving & Heavy Lifting': 'ส่งของ (Delivery)',
  'Physics Tutoring': 'สอนหนังสือ (Teaching)',
  'Plant Care & Gardening': otherQuestTagName,
  'Presentation & Slide Design': 'ออกแบบ (Design)',
  'Proofreading & Editing': 'งานและการบ้าน (Work/Homework)',
  'Queue Standing & Spot Holding': 'ส่งของ (Delivery)',
  'Social Media Management': 'งานและการบ้าน (Work/Homework)',
  'Software Testing & QA': 'งานและการบ้าน (Work/Homework)',
  'Stage & Equipment Setup': 'เกมและสันทนาการ (Game/Activity)',
  'Statistical Analysis': 'งานและการบ้าน (Work/Homework)',
  'Survey & Field Data Collection': 'งานและการบ้าน (Work/Homework)',
  'Thai-English Translation': 'งานและการบ้าน (Work/Homework)',
  'UI/UX Design': 'ออกแบบ (Design)',
  'Video Editing & Post-Production': 'ถ่ายภาพ (Photography)',
};

export const listTags = async (options?: TagSearchOptions): Promise<TagPage> => {
  const limit = options?.limit ?? DEFAULT_PAGE_LIMIT;
  const cursorPayload = decodeTagCursor(options?.cursor);

  const rawQuery = options?.q?.trim();
  const searchFilter = rawQuery
    ? ilike(tag.name, `%${rawQuery.replace(/[%_\\]/g, '\\$&')}%`)
    : undefined;

  let probe: Tag[];

  if (cursorPayload) {
    const cursorFilter = or(
      gt(tag.name, cursorPayload.name),
      and(eq(tag.name, cursorPayload.name), gt(tag.id, cursorPayload.id))
    );

    probe = await db
      .select({ id: tag.id, name: tag.name })
      .from(tag)
      .where(and(searchFilter, cursorFilter))
      .orderBy(asc(tag.name), asc(tag.id))
      .limit(limit + 1);
  } else {
    probe = await db
      .select({ id: tag.id, name: tag.name })
      .from(tag)
      .where(searchFilter)
      .orderBy(asc(tag.name), asc(tag.id))
      .limit(limit + 1);
  }

  const hasNext = probe.length > limit;
  const items = hasNext ? probe.slice(0, limit) : probe;
  const lastItem = items[items.length - 1];

  return {
    items,
    nextCursor: hasNext && lastItem ? encodeTagCursor(lastItem) : null,
  };
};

export const seedQuestTags = async (): Promise<{ total: number; removed: number }> =>
  db.transaction(async (tx) => {
    await tx
      .insert(tag)
      .values(fixedTagNames.map((name) => ({ name })))
      .onConflictDoNothing({ target: tag.name });

    const currentTags = await tx.select({ id: tag.id, name: tag.name }).from(tag);
    const tagByName = new Map(currentTags.map((row) => [row.name, row.id]));
    const allowedSet = new Set<string>(fixedTagNames);

    const legacyTags = currentTags.filter((row) => !allowedSet.has(row.name));
    const legacyIds = legacyTags.map((row) => row.id);

    if (legacyIds.length > 0) {
      await Promise.all(
        legacyTags.map(async (legacy) => {
          const targetName = legacyTagMappings[legacy.name] ?? otherQuestTagName;
          const targetId = tagByName.get(targetName)!;
          await tx.update(quest).set({ tagId: targetId }).where(eq(quest.tagId, legacy.id));
        })
      );

      await tx.delete(tag).where(inArray(tag.id, legacyIds));
    }

    return {
      total: fixedTagNames.length,
      removed: legacyTags.length,
    };
  });
