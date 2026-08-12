import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';

import type { Static } from 'elysia';

import type {
  workExperienceCreateSchema,
  workExperienceListResponseSchema,
  workExperienceParamsSchema,
  workExperienceResponseSchema,
  workExperienceUpdateSchema,
} from './work-experience.schema';
import {
  createWorkExperience,
  deleteWorkExperience,
  listWorkExperiences,
  updateWorkExperience,
} from './work-experience.service';
import type { WorkExperience } from './work-experience.service';

type WorkExperienceResponse = Static<typeof workExperienceResponseSchema>['data']['experience'];
type WorkExperienceListResponse = Static<typeof workExperienceListResponseSchema>['data'];
type WorkExperienceParams = { params: Static<typeof workExperienceParamsSchema> };

export const serializeWorkExperience = (experience: WorkExperience): WorkExperienceResponse => ({
  ...experience,
  createdAt: experience.createdAt.toISOString(),
  updatedAt: experience.updatedAt.toISOString(),
});

const notFound = (set: AuthedContext['set']) => {
  set.status = 404;
  return apiError('EXPERIENCE_NOT_FOUND', 'Work experience not found');
};

const invalidDateRange = (set: AuthedContext['set']) => {
  set.status = 400;
  return apiError('INVALID_EXPERIENCE_DATES', 'endedAt must be on or after startedAt');
};

export const listOwnWorkExperiences = async ({
  session,
}: AuthedContext): Promise<ApiResponse<WorkExperienceListResponse>> =>
  apiSuccess((await listWorkExperiences(session.user.id)).map(serializeWorkExperience));

export const createOwnWorkExperience = async ({
  body,
  session,
  set,
}: AuthedContext & { body: Static<typeof workExperienceCreateSchema> }): Promise<
  ApiResponse<{ experience: WorkExperienceResponse }>
> => {
  const experience = await createWorkExperience(session.user.id, body);

  if ('outcome' in experience) return invalidDateRange(set);

  return apiSuccess({ experience: serializeWorkExperience(experience) });
};

export const updateOwnWorkExperience = async ({
  body,
  params,
  session,
  set,
}: AuthedContext &
  WorkExperienceParams & {
    body: Static<typeof workExperienceUpdateSchema>;
  }): Promise<ApiResponse<{ experience: WorkExperienceResponse }>> => {
  const experience = await updateWorkExperience(session.user.id, params.experienceId, body);

  if (!experience) return notFound(set);
  if ('outcome' in experience) return invalidDateRange(set);

  return apiSuccess({ experience: serializeWorkExperience(experience) });
};

export const deleteOwnWorkExperience = async ({
  params,
  session,
  set,
}: AuthedContext & WorkExperienceParams): Promise<ApiResponse> => {
  const deleted = await deleteWorkExperience(session.user.id, params.experienceId);

  if (!deleted) return notFound(set);

  return apiSuccess();
};
