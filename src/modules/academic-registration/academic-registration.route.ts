import { authGuard } from '@/modules/auth';
import { apiSuccessSchema, betterAuthSecurity, responses } from '@/shared/api-response.schema';
import { API_V1_PREFIX } from '@/shared/api-version';
import { rejectUnknownFields } from '@/shared/reject-unknown-fields';

import { Elysia } from 'elysia';

import {
  getAcademicRegistrationOptionsController,
  getAcademicRegistrationStatusController,
  updateAcademicRegistrationController,
} from './academic-registration.controller';
import {
  academicRegistrationOptionsResponseSchema,
  academicRegistrationStatusResponseSchema,
  academicRegistrationUpdateSchema,
} from './academic-registration.schema';

export const academicRegistrationRoute = new Elysia({
  name: 'academic-registration-route',
  prefix: `${API_V1_PREFIX}/academic-registration`,
})
  .use(authGuard)
  .get('/options', getAcademicRegistrationOptionsController, {
    response: responses(academicRegistrationOptionsResponseSchema, 401),
    detail: {
      tags: ['Academic Registration'],
      summary: 'List Occupation and Faculty/Department options',
      description: 'Lists the seeded Occupations and Faculty/Department hierarchy for the Academic Registration form.',
      operationId: 'getAcademicRegistrationOptions',
      security: betterAuthSecurity,
    },
  })
  .get('/status', getAcademicRegistrationStatusController, {
    response: responses(academicRegistrationStatusResponseSchema, 401, 404),
    detail: {
      tags: ['Academic Registration'],
      summary: 'Get Academic Registration status',
      description: 'Returns the current field values for pre-filling the form, plus a computed completed flag.',
      operationId: 'getAcademicRegistrationStatus',
      security: betterAuthSecurity,
    },
  })
  .patch('', updateAcademicRegistrationController, {
    body: academicRegistrationUpdateSchema,
    transform: rejectUnknownFields(academicRegistrationUpdateSchema),
    response: responses(apiSuccessSchema, 400, 401, 404, 409),
    detail: {
      tags: ['Academic Registration'],
      summary: 'Update Academic Registration information',
      description:
        'Draft-saves Academic Registration fields for the authenticated Student. Fields left out keep their current value; values cannot be cleared.',
      operationId: 'updateAcademicRegistration',
      security: betterAuthSecurity,
    },
  });
