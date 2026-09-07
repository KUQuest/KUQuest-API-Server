import type { AuthedContext } from '@/modules/auth';
import { apiError, apiSuccess } from '@/shared/api-response';
import type { ApiResponse } from '@/shared/api-response';
import { readResourceVersion } from '@/shared/resource-version';

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
  request,
  session,
  set,
}: AuthedContext &
  WorkExperienceParams & {
    body: Static<typeof workExperienceUpdateSchema>;
  }): Promise<ApiResponse<{ experience: WorkExperienceResponse }>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }

  const experience = await updateWorkExperience(
    session.user.id,
    params.experienceId,
    body,
    versionHeader.value,
  );

  if (!experience) return notFound(set);
  if ('outcome' in experience && experience.outcome === 'conflict') {
    set.status = 409;
    return apiError('CONFLICT', 'Work Experience was changed by another request');
  }
  if ('outcome' in experience) return invalidDateRange(set);

  return apiSuccess({ experience: serializeWorkExperience(experience) });
};

export const deleteOwnWorkExperience = async ({
  params,
  request,
  session,
  set,
}: AuthedContext & WorkExperienceParams): Promise<ApiResponse<{ version: number }>> => {
  const versionHeader = readResourceVersion(request);
  if (versionHeader.invalid) {
    set.status = 400;
    return apiError('INVALID_VERSION', 'Resource version must be a positive integer');
  }

  const deleted = await deleteWorkExperience(
    session.user.id,
    params.experienceId,
    versionHeader.value,
  );

  if (!deleted) return notFound(set);
  if (!('outcome' in deleted)) return apiSuccess({ version: deleted.version ?? 1 });
  if (deleted.outcome === 'conflict') {
    set.status = 409;
    return apiError('CONFLICT', 'Work Experience was changed by another request');
  }

  return apiSuccess({ version: deleted.version });
};
