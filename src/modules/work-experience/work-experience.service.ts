import { db } from '@/database/client';
import { profileWorkExperience } from '@/database/schema/profile.schema';

import { and, asc, desc, eq } from 'drizzle-orm';
import type { Static } from 'elysia';

import type {
  workExperienceCreateSchema,
  workExperienceUpdateSchema,
} from './work-experience.schema';

export type WorkExperienceInput = Static<typeof workExperienceCreateSchema>;
export type WorkExperienceUpdate = Static<typeof workExperienceUpdateSchema>;

export type WorkExperience = {
  id: string;
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
  | undefined;

export const updateWorkExperience = async (
  userId: string,
  experienceId: string,
  data: WorkExperienceUpdate,
): Promise<UpdateWorkExperienceOutcome> => {
  const current = await findWorkExperience(userId, experienceId);
  if (!current) return undefined;
  if (Object.keys(data).length === 0) return current;

  const startedAt = data.startedAt ?? current.startedAt;
  const endedAt = data.endedAt === undefined ? current.endedAt : data.endedAt;
  if (!hasValidDateRange(startedAt, endedAt)) {
    return { outcome: 'invalid-date-range' };
  }

  await db
    .update(profileWorkExperience)
    .set({
      title: data.title ?? current.title,
      employmentType: data.employmentType ?? current.employmentType,
      org: data.organization === undefined ? current.organization : data.organization,
      description: data.description === undefined ? current.description : data.description,
      startedAt,
      endedAt,
      updatedAt: new Date(),
    })
    .where(ownedBy(userId, experienceId));

  return findWorkExperience(userId, experienceId);
};

export const deleteWorkExperience = async (
  userId: string,
  experienceId: string,
): Promise<{ id: string } | undefined> => {
  const [deleted] = await db
    .delete(profileWorkExperience)
    .where(ownedBy(userId, experienceId))
    .returning({ id: profileWorkExperience.id });

  return deleted;
};
