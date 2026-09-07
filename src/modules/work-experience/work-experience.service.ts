import { db } from '@/database/client';
import { profileWorkExperience } from '@/database/schema/profile.schema';

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Static } from 'elysia';

import type {
  workExperienceCreateSchema,
  workExperienceUpdateSchema,
} from './work-experience.schema';

export type WorkExperienceInput = Static<typeof workExperienceCreateSchema>;
export type WorkExperienceUpdate = Static<typeof workExperienceUpdateSchema>;

export type WorkExperience = {
  id: string;
  version: number;
  title: string;
  employmentType: string;
  organization: string | null;
  description: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const workExperienceColumns = {
  id: profileWorkExperience.id,
  version: profileWorkExperience.version,
  title: profileWorkExperience.title,
  employmentType: profileWorkExperience.employmentType,
  organization: profileWorkExperience.org,
  description: profileWorkExperience.description,
  startedAt: profileWorkExperience.startedAt,
  endedAt: profileWorkExperience.endedAt,
  createdAt: profileWorkExperience.createdAt,
  updatedAt: profileWorkExperience.updatedAt,
};

const ownedBy = (userId: string, experienceId: string) =>
  and(eq(profileWorkExperience.userId, userId), eq(profileWorkExperience.id, experienceId));

const hasValidDateRange = (startedAt: string, endedAt: string | null | undefined) =>
  endedAt === undefined || endedAt === null || endedAt >= startedAt;

export const listWorkExperiences = async (userId: string): Promise<WorkExperience[]> =>
  db
    .select(workExperienceColumns)
    .from(profileWorkExperience)
    .where(eq(profileWorkExperience.userId, userId))
    .orderBy(
      desc(profileWorkExperience.startedAt),
      desc(profileWorkExperience.createdAt),
      asc(profileWorkExperience.id),
    );

export const findWorkExperience = async (
  userId: string,
  experienceId: string,
): Promise<WorkExperience | undefined> => {
  const [experience] = await db
    .select(workExperienceColumns)
    .from(profileWorkExperience)
    .where(ownedBy(userId, experienceId))
    .limit(1);

  return experience;
};

export type CreateWorkExperienceOutcome = WorkExperience | { outcome: 'invalid-date-range' };

export const createWorkExperience = async (
  userId: string,
  data: WorkExperienceInput,
): Promise<CreateWorkExperienceOutcome> => {
  if (!hasValidDateRange(data.startedAt, data.endedAt)) {
    return { outcome: 'invalid-date-range' };
  }

  const [created] = await db
    .insert(profileWorkExperience)
    .values({
      userId,
      title: data.title,
      employmentType: data.employmentType,
      org: data.organization ?? null,
      description: data.description ?? null,
      startedAt: data.startedAt,
      endedAt: data.endedAt ?? null,
    })
    .returning({ id: profileWorkExperience.id });

  return (await findWorkExperience(userId, created.id))!;
};

export type UpdateWorkExperienceOutcome =
  | WorkExperience
  | { outcome: 'invalid-date-range' }
  | { outcome: 'conflict' }
  | undefined;

export const updateWorkExperience = async (
  userId: string,
  experienceId: string,
  data: WorkExperienceUpdate,
  expectedVersion?: number,
): Promise<UpdateWorkExperienceOutcome> => {
  const current = await findWorkExperience(userId, experienceId);
  if (!current) return undefined;
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { outcome: 'conflict' };
  }
  if (Object.keys(data).length === 0) return current;

  const startedAt = data.startedAt ?? current.startedAt;
  const endedAt = data.endedAt === undefined ? current.endedAt : data.endedAt;
  if (!hasValidDateRange(startedAt, endedAt)) {
    return { outcome: 'invalid-date-range' };
  }

  const updated = await db
    .update(profileWorkExperience)
    .set({
      title: data.title ?? current.title,
      employmentType: data.employmentType ?? current.employmentType,
      org: data.organization === undefined ? current.organization : data.organization,
      description: data.description === undefined ? current.description : data.description,
      startedAt,
      endedAt,
      updatedAt: new Date(),
      version: sql`${profileWorkExperience.version} + 1`,
    })
    .where(
      expectedVersion === undefined
        ? ownedBy(userId, experienceId)
        : and(ownedBy(userId, experienceId), eq(profileWorkExperience.version, expectedVersion)),
    )
    .returning({ id: profileWorkExperience.id });

  if (updated.length === 0) return { outcome: 'conflict' };

  return findWorkExperience(userId, experienceId);
};

export type DeleteWorkExperienceOutcome =
  | { outcome: 'deleted'; id: string; version: number }
  | { id: string; version?: number }
  | { outcome: 'conflict' }
  | undefined;

export const deleteWorkExperience = async (
  userId: string,
  experienceId: string,
  expectedVersion?: number,
): Promise<DeleteWorkExperienceOutcome> => {
  const current = await findWorkExperience(userId, experienceId);
  if (!current) return undefined;
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    return { outcome: 'conflict' };
  }

  const [deleted] = await db
    .delete(profileWorkExperience)
    .where(
      expectedVersion === undefined
        ? ownedBy(userId, experienceId)
        : and(ownedBy(userId, experienceId), eq(profileWorkExperience.version, expectedVersion)),
    )
    .returning({ id: profileWorkExperience.id });

  if (!deleted) return { outcome: 'conflict' };
  return { outcome: 'deleted', id: deleted.id, version: current.version + 1 };
};
