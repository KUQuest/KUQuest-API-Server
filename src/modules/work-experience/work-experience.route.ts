import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  createOwnWorkExperience,
  deleteOwnWorkExperience,
  listOwnWorkExperiences,
  updateOwnWorkExperience,
} from './work-experience.controller';
import {
  workExperienceCreateSchema,
  workExperienceListResponseSchema,
  workExperienceParamsSchema,
  workExperienceResponseSchema,
  workExperienceUpdateSchema,
} from './work-experience.schema';

export const workExperienceRoute = new Elysia({
  name: 'work-experience-route',
  prefix: `${API_V1_PREFIX}/profile/experience`,
})
  .use(authGuard)
  .get('', listOwnWorkExperiences, {
    response: responses(workExperienceListResponseSchema, 401),
    detail: {
      tags: ['Profile'],
      summary: 'List own work experience',
      description: 'Returns the authenticated Student work experience ordered by newest start date.',
      operationId: 'listOwnWorkExperience',
      security: betterAuthSecurity,
    },
  })
  .post('', createOwnWorkExperience, {
    body: workExperienceCreateSchema,
    transform: rejectUnknownFields(workExperienceCreateSchema),
    response: responses(workExperienceResponseSchema, 400, 401),
    detail: {
      tags: ['Profile'],
      summary: 'Create work experience',
      description: 'Creates a work experience entry owned by the authenticated Student.',
      operationId: 'createWorkExperience',
      security: betterAuthSecurity,
    },
  })
  .patch('/:experienceId', updateOwnWorkExperience, {
    params: workExperienceParamsSchema,
    body: workExperienceUpdateSchema,
    transform: rejectUnknownFields(workExperienceUpdateSchema),
    response: responses(workExperienceResponseSchema, 400, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Update work experience',
      description: 'Updates a work experience entry owned by the authenticated Student.',
      operationId: 'updateWorkExperience',
      security: betterAuthSecurity,
    },
  })
  .delete('/:experienceId', deleteOwnWorkExperience, {
    params: workExperienceParamsSchema,
    response: responses(apiSuccessSchema, 401, 404),
    detail: {
      tags: ['Profile'],
      summary: 'Delete work experience',
      description: 'Deletes a work experience entry owned by the authenticated Student.',
      operationId: 'deleteWorkExperience',
      security: betterAuthSecurity,
    },
  });
