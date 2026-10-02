import { db } from '@/database/client';
import { quest } from '@/database/schema/quest.schema';
import { tag } from '@/database/schema/tag.schema';
import { DEFAULT_PAGE_LIMIT } from '@/shared/cursor';
import { fixedTagNames, fixedTagNamesTh, otherQuestTagName, type FixedTagName } from '@/shared/tag';

import { and, asc, eq, gt, ilike, inArray, or } from 'drizzle-orm';

import { decodeTagCursor, encodeTagCursor } from './tag.cursor';

export type Tag = {
  id: string;
  name: string;
  nameTh: string | null;
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
  '3D Modeling & Animation': 'Design',
  'Academic Writing': 'Work/Homework',
  'Accounting & Bookkeeping': 'Work/Homework',
  'Agricultural Field Work': otherQuestTagName,
  'Animal Care & Pet Sitting': 'Pet',
  'Audio Production & Music': 'Design',
  'Backend Development': 'Work/Homework',
  'Biology Tutoring': 'Teaching',
  'Business Planning': 'Work/Homework',
  'Campus Errand & Delivery': 'Delivery',
  'Campus Tour & Guiding': 'Game/Activity',
  'Chemistry Tutoring': 'Teaching',
  'Chinese Translation': 'Work/Homework',
  'Computer Science Tutoring': 'Teaching',
  Content: 'Work/Homework',
  'Content Writing & Copywriting': 'Work/Homework',
  Cybersecurity: 'Work/Homework',
  'Data Analysis': 'Work/Homework',
  'Data Entry & Transcription': 'Work/Homework',
  'Data Visualization': 'Work/Homework',
  'Database Management': 'Work/Homework',
  'DevOps & Cloud Infrastructure': 'Work/Homework',
  'Document Printing & Pickup': 'Delivery',
  'English Tutoring': 'Teaching',
  'English-Thai Translation': 'Work/Homework',
  'Event Photography & Videography': 'Photography',
  'Event Staff & Ushering': 'Game/Activity',
  'Exam Preparation': 'Teaching',
  'Food Science & Quality Testing': 'Food and Drinks',
  Frontend: 'Work/Homework',
  'Frontend Development': 'Work/Homework',
  'Fullstack Development': 'Work/Homework',
  'Game Development': 'Work/Homework',
  'General Assistance': otherQuestTagName,
  'Graphic Design': 'Design',
  'Illustration & Digital Art': 'Design',
  'Japanese Translation': 'Work/Homework',
  'Logo & Branding Design': 'Design',
  'MC & Public Speaking': 'Game/Activity',
  'Machine Learning & AI': 'Work/Homework',
  'Market Research': 'Work/Homework',
  'Marketing Campaign': 'Work/Homework',
  'Mathematics Tutoring': 'Teaching',
  'Mobile App Development': 'Work/Homework',
  'Motion Graphics': 'Design',
  'Moving & Heavy Lifting': 'Delivery',
  'Physics Tutoring': 'Teaching',
  'Plant Care & Gardening': otherQuestTagName,
  'Presentation & Slide Design': 'Design',
  'Proofreading & Editing': 'Work/Homework',
  'Queue Standing & Spot Holding': 'Delivery',
  'Social Media Management': 'Work/Homework',
  'Software Testing & QA': 'Work/Homework',
  'Stage & Equipment Setup': 'Game/Activity',
  'Statistical Analysis': 'Work/Homework',
  'Survey & Field Data Collection': 'Work/Homework',
  'Thai-English Translation': 'Work/Homework',
  'UI/UX Design': 'Design',
  'Video Editing & Post-Production': 'Photography',
  'ทำความสะอาด (Cleaning)': 'Cleaning',
  'ส่งของ (Delivery)': 'Delivery',
  'ซ่อมแซม (Fixing)': 'Fixing',
  'สอนหนังสือ (Teaching)': 'Teaching',
  'กีฬา (Sport)': 'Sport',
  'เกมและสันทนาการ (Game/Activity)': 'Game/Activity',
  'งานและการบ้าน (Work/Homework)': 'Work/Homework',
  'อาหารและเครื่องดื่ม (Food and Drinks)': 'Food and Drinks',
  'สัตว์เลี้ยง (Pet)': 'Pet',
  'ออกแบบ (Design)': 'Design',
  'ถ่ายภาพ (Photography)': 'Photography',
  'อื่นๆ (ETC.)': otherQuestTagName,
};

const tagLabelsTh: Readonly<Record<string, string | undefined>> = fixedTagNamesTh;

export const listTags = async (options?: TagSearchOptions): Promise<TagPage> => {
  const limit = options?.limit ?? DEFAULT_PAGE_LIMIT;
  const cursorPayload = decodeTagCursor(options?.cursor);

  const rawQuery = options?.q?.trim();
  const searchFilter = rawQuery
    ? ilike(tag.name, `%${rawQuery.replace(/[%_\\]/g, '\\$&')}%`)
    : undefined;

  let probe: Pick<Tag, 'id' | 'name'>[];

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
  const items = (hasNext ? probe.slice(0, limit) : probe).map((row) => ({
    ...row,
    nameTh: tagLabelsTh[row.name] ?? null,
  }));
  const lastItem = probe[Math.min(probe.length, limit) - 1];

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
